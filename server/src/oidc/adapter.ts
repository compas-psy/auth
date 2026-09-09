import { getPool } from "../db/pool.js";
import { findClient, toProviderClient } from "./clients.js";

type Payload = Record<string, unknown>;

/**
 * Адаптер хранения oidc-provider на Postgres.
 *
 * Встроенный in-memory в production не годится: он теряет состояние при
 * перезапуске — подтверждено context7 (docs/README.md, «Configuration >
 * adapter») и чтением lib/adapters/memory_adapter.js@8.8.1.
 *
 * Контракт сверен по эталонному адаптеру библиотеки, а не по плану:
 *   upsert(id, payload, expiresIn)  expiresIn в СЕКУНДАХ, может отсутствовать
 *   find(id)                        → payload | undefined
 *   findByUid(uid)                  → Session
 *   findByUserCode(userCode)        → DeviceCode
 *   consume(id)                     → проставить payload.consumed = epochTime()
 *   destroy(id)                     → удалить
 *   revokeByGrantId(grantId)        → удалить все записи гранта, всех типов
 */
export class PostgresAdapter {
  constructor(private readonly type: string) {}

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    // Секунды приходят числом; отсутствие срока — это NULL, а не
    // строка "undefined seconds", на которой вставка падает.
    const seconds =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : null;
    await getPool().query(
      `INSERT INTO oidc_payloads (id, type, payload, grant_id, user_code, uid, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $7::bigint IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $7::bigint) END)
       ON CONFLICT (type, id) DO UPDATE
         SET payload    = EXCLUDED.payload,
             grant_id   = EXCLUDED.grant_id,
             user_code  = EXCLUDED.user_code,
             uid        = EXCLUDED.uid,
             expires_at = EXCLUDED.expires_at`,
      [
        id,
        this.type,
        payload,
        (payload.grantId as string | undefined) ?? null,
        (payload.userCode as string | undefined) ?? null,
        (payload.uid as string | undefined) ?? null,
        seconds,
      ],
    );
  }

  private async one(column: "id" | "user_code" | "uid", value: string): Promise<Payload | undefined> {
    const { rows } = await getPool().query<{ payload: Payload; consumed_at: Date | null }>(
      `SELECT payload, consumed_at FROM oidc_payloads
       WHERE type = $1 AND ${column} = $2
         AND (expires_at IS NULL OR expires_at > now())`,
      [this.type, value],
    );
    const row = rows[0];
    if (!row) return undefined;
    const payload = row.payload;
    if (row.consumed_at) {
      // Секунды эпохи — так ставит epochTime() в эталонном адаптере.
      payload.consumed = Math.floor(row.consumed_at.getTime() / 1000);
    }
    return payload;
  }

  find(id: string): Promise<Payload | undefined> {
    // Клиенты живут в реестре oidc_clients, а не в хранилище протокола.
    if (this.type === "Client") return findRegisteredClient(id);
    return this.one("id", id);
  }

  findByUserCode(userCode: string): Promise<Payload | undefined> {
    return this.one("user_code", userCode);
  }

  findByUid(uid: string): Promise<Payload | undefined> {
    return this.one("uid", uid);
  }

  /**
   * Гашение, а не удаление: погашенный код обязан остаться найденным,
   * иначе повторное предъявление выглядит как «кода не было» вместо
   * «код уже использован», и грант не уничтожается.
   */
  async consume(id: string): Promise<void> {
    await getPool().query(
      "UPDATE oidc_payloads SET consumed_at = now() WHERE type = $1 AND id = $2",
      [this.type, id],
    );
  }

  async destroy(id: string): Promise<void> {
    await getPool().query("DELETE FROM oidc_payloads WHERE type = $1 AND id = $2", [
      this.type,
      id,
    ]);
  }

  /**
   * Отзыв гранта уносит записи ВСЕХ типов: иначе refresh переживает
   * отзыв разрешения. Тип здесь намеренно не фильтруется — так же
   * устроен эталонный адаптер.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    await getPool().query("DELETE FROM oidc_payloads WHERE grant_id = $1", [grantId]);
  }
}

/**
 * Поиск клиента в реестре — НА КАЖДЫЙ ЗАПРОС, а не один раз при старте.
 *
 * Библиотека спрашивает адаптер о клиентах, которых нет в статическом
 * перечне (lib/models/client.js, Client.find: сначала staticClients,
 * затем this.adapter.find(id) — подтверждено context7). Мы статический
 * перечень не задаём вовсе, поэтому единственный источник истины —
 * таблица oidc_clients: заведение и отключение клиента действуют сразу.
 *
 * Пустые поля выбрасываются: null в метаданных библиотека считает
 * заданным значением, и публичный клиент с client_secret: null
 * перестаёт быть публичным (эталонная рекомендация адаптера —
 * omitBy(data, isNull) для типа Client).
 */
async function findRegisteredClient(id: string): Promise<Payload | undefined> {
  const record = await findClient(id);
  if (!record) return undefined;
  const metadata = toProviderClient(record);
  return Object.fromEntries(
    Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null),
  );
}

/** Уборка просроченного. Хранилище протокола не должно расти вечно. */
export async function purgeExpiredPayloads(): Promise<number> {
  const { rowCount } = await getPool().query(
    "DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at < now() - interval '1 day'",
  );
  return rowCount ?? 0;
}
