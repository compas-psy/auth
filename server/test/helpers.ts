import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

let migrated = false;

/** Прогоняет миграции один раз на весь прогон тестов. */
export async function ensureSchema(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
}

/**
 * Чистит данные между тестами. Справочники — реестр документов и их
 * опубликованные редакции — не трогаются: это не данные пользователя,
 * а часть схемы, и без них согласие некуда записать.
 */
const REFERENCE_TABLES = new Set([
  "schema_migrations",
  "legal_documents",
  "legal_document_versions",
  "oidc_clients",
]);

export async function resetData(): Promise<void> {
  await ensureSchema();
  const { rows } = await getPool().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND NOT (tablename = ANY($1::text[]))`,
    [[...REFERENCE_TABLES]],
  );
  if (!rows.length) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await getPool().query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

/**
 * Клиент для тестов протокола. Реестр клиентов живёт в базе, а не в
 * конфигурации, — поэтому его надо завести до сборки сервера.
 */
export async function ensureTestClient(): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO oidc_clients
       (client_id, client_name, client_secret, redirect_uris, auth_method, first_party, product)
     VALUES ('test', 'Тестовый клиент', $1, ARRAY['https://ex.test/cb'],
             'client_secret_basic', false, NULL)
     ON CONFLICT (client_id) DO NOTHING`,
    ["t".repeat(43)],
  );
  await getPool().query(
    `INSERT INTO oidc_clients
       (client_id, client_name, client_secret, redirect_uris, auth_method, first_party, product)
     VALUES ('practice-mobile', 'ПРАКТИКА для Android', NULL, ARRAY[]::text[],
             'none', true, 'practice')
     ON CONFLICT (client_id) DO NOTHING`,
  );
}

/** Ключ доступа для тестов API. Выпускается тем же путём, что и в бою. */
export async function issueTestToken(
  accountId: string,
  device: { deviceKey?: string; platform?: string; client?: string } = {},
): Promise<{ token: string; sessionId: string }> {
  const { issueTokens } = await import("../src/services/tokens.js");
  const pair = await issueTokens(accountId, {
    deviceKey: device.deviceKey ?? "test-device",
    platform: device.platform ?? "windows",
    client: device.client ?? "chrome",
  });
  return { token: pair.access_token, sessionId: pair.session_id };
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
