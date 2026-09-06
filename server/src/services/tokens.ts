import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, importJWK, type JWK } from "jose";
import { getPool, withTransaction } from "../db/pool.js";
import { sha256 } from "../lib/hash.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKeys } from "../lib/keys.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  session_id: string;
}

export interface DeviceInfo {
  deviceKey: string;
  platform: string;
  client?: string | null;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_grant" | "reuse_detected" | "revoked" | "expired",
  ) {
    super(message);
    this.name = "TokenError";
  }
}

/** Выпуск пары на новое устройство: новый сеанс, новая цепочка refresh. */
export async function issueTokens(
  accountId: string,
  device: DeviceInfo,
): Promise<TokenPair> {
  return withTransaction(async (client) => {
    const s = await client.query<{ id: string }>(
      `INSERT INTO sessions (account_id, platform, client, device_key, kind)
       VALUES ($1,$2,$3,$4,'first_party') RETURNING id`,
      [accountId, device.platform, device.client ?? null, device.deviceKey],
    );
    const sessionId = s.rows[0]!.id;
    const chainId = await newChainId(client);
    const refresh = await insertRefresh(client, {
      sessionId, accountId, chainId, device,
    });
    return {
      access_token: await signAccessToken(accountId, sessionId),
      refresh_token: refresh,
      expires_in: ACCESS_TTL_SECONDS,
      session_id: sessionId,
    };
  });
}

/**
 * Ротация. Каждое использование выдаёт НОВЫЙ refresh, прежний
 * помечается использованным.
 *
 * Приход уже потраченного токена означает, что им владеет кто-то ещё:
 * гасится вся цепочка устройства, и человеку нужен новый вход. Без этой
 * реакции ротация бессмысленна.
 */
export async function rotateRefresh(refreshToken: string): Promise<TokenPair> {
  const hash = sha256(refreshToken);
  type Rotation = { reuseOf: string } | { pair: TokenPair };
  const result: Rotation = await withTransaction<Rotation>(async (client) => {
    const { rows } = await client.query<{
      id: string; session_id: string; account_id: string; chain_id: string;
      device_key: string; platform: string; used_at: Date | null;
      revoked_at: Date | null; expired: boolean; session_revoked: Date | null;
      session_client: string | null;
    }>(
      `SELECT f.id, f.session_id, f.account_id, f.chain_id, f.device_key, f.platform,
              f.used_at, f.revoked_at, (f.expires_at <= now()) AS expired,
              s.revoked_at AS session_revoked, s.client AS session_client
       FROM first_party_sessions f
       JOIN sessions s ON s.id = f.session_id
       WHERE f.refresh_hash = $1
       FOR UPDATE OF f`,
      [hash],
    );
    const row = rows[0];
    // Неизвестный токен ничего не гасит: иначе случайная строка от
    // постороннего убивала бы чужие сеансы.
    if (!row) throw new TokenError("unknown refresh token", "invalid_grant");

    // Гашение цепочки НЕ делается здесь: эта транзакция обязана
    // завершиться исключением, а исключение откатывает и гашение —
    // цепочка осталась бы живой. Отзыв идёт отдельной транзакцией ниже.
    if (row.used_at) return { reuseOf: row.chain_id };
    if (row.revoked_at || row.session_revoked) {
      throw new TokenError("session revoked", "revoked");
    }
    if (row.expired) throw new TokenError("refresh token expired", "expired");

    await client.query(
      "UPDATE first_party_sessions SET used_at = now() WHERE id = $1",
      [row.id],
    );
    await client.query(
      "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
      [row.session_id],
    );
    const refresh = await insertRefresh(client, {
      sessionId: row.session_id,
      accountId: row.account_id,
      chainId: row.chain_id,
      device: {
        deviceKey: row.device_key,
        platform: row.platform,
        client: row.session_client,
      },
    });
    return {
      pair: {
        access_token: await signAccessToken(row.account_id, row.session_id),
        refresh_token: refresh,
        expires_in: ACCESS_TTL_SECONDS,
        session_id: row.session_id,
      },
    };
  });

  if ("reuseOf" in result) {
    await revokeChain(result.reuseOf, "reuse_detected");
    throw new TokenError("refresh token reuse detected", "reuse_detected");
  }
  return result.pair;
}

/** Отзыв сеанса из портала. Немедленно убивает и refresh, и access. */
export async function revokeSession(
  accountId: string,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
       WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`,
      [sessionId, accountId, reason],
    );
    if (!rowCount) return false;
    await client.query(
      `UPDATE first_party_sessions
       SET revoked_at = now(), revoked_reason = $2
       WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    return true;
  });
}

export async function revokeOtherSessions(
  accountId: string,
  keepSessionId: string | null,
  reason: string,
): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
       WHERE account_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)
       RETURNING id`,
      [accountId, keepSessionId, reason],
    );
    if (rows.length) {
      await client.query(
        `UPDATE first_party_sessions SET revoked_at = now(), revoked_reason = $2
         WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [rows.map((r) => r.id), reason],
      );
    }
    return rows.length;
  });
}

export interface AccessClaims {
  accountId: string;
  sessionId: string;
}

/**
 * Проверка нашего access-токена. Подпись — той же парой ключей, что и
 * id_token; своей криптографии нет, всё делает jose.
 *
 * Отозванный сеанс перестаёт действовать сразу, а не по истечении
 * пятнадцати минут: без сверки с базой «завершить сеанс» на экране
 * означало бы «завершить, но попозже».
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  const { issuer } = loadConfig();
  try {
    const keys = loadOrCreateKeys().keys;
    for (const jwk of keys) {
      try {
        const key = await importJWK(jwk as unknown as JWK, "RS256");
        const { payload } = await jwtVerify(token, key, {
          issuer,
          audience: `${issuer}/v1`,
        });
        const accountId = String(payload.sub ?? "");
        const sessionId = String(payload.sid ?? "");
        if (!accountId || !sessionId) return null;
        const { rows } = await getPool().query(
          `SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
           WHERE s.id = $1 AND s.account_id = $2
             AND s.revoked_at IS NULL AND a.status = 'active'`,
          [sessionId, accountId],
        );
        if (!rows.length) return null;
        return { accountId, sessionId };
      } catch {
        // Следующий ключ: после ротации в JWKS их несколько.
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function signAccessToken(accountId: string, sessionId: string): Promise<string> {
  const { issuer } = loadConfig();
  const jwk = loadOrCreateKeys().keys[0]!;
  const key = await importJWK(jwk as unknown as JWK, "RS256");
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "RS256", kid: String(jwk.kid) })
    .setSubject(accountId)
    .setIssuer(issuer)
    .setAudience(`${issuer}/v1`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key);
}

type Client = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function newChainId(client: Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>("SELECT gen_random_uuid() AS id");
  return rows[0]!.id;
}

async function insertRefresh(
  client: Client,
  i: { sessionId: string; accountId: string; chainId: string; device: DeviceInfo },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO first_party_sessions
       (session_id, account_id, chain_id, device_key, platform, refresh_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7::int))`,
    [i.sessionId, i.accountId, i.chainId, i.device.deviceKey, i.device.platform,
     sha256(token), REFRESH_TTL_DAYS],
  );
  return token;
}

async function revokeChainInternal(
  client: Client,
  chainId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE first_party_sessions SET revoked_at = now(), revoked_reason = $2
     WHERE chain_id = $1 AND revoked_at IS NULL`,
    [chainId, reason],
  );
  await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
     WHERE id IN (SELECT session_id FROM first_party_sessions WHERE chain_id = $1)
       AND revoked_at IS NULL`,
    [chainId, reason],
  );
}

/** Публичный отзыв цепочки — по требованию 12_NATIVE_AUTH.md §3.2. */
export async function revokeChain(chainId: string, reason = "revoked"): Promise<void> {
  await withTransaction((client) => revokeChainInternal(client, chainId, reason));
}
