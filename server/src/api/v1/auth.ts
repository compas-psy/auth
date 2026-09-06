import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isFirstParty } from "../../oidc/clients.js";
import {
  issueTokens, rotateRefresh, revokeSession, TokenError, verifyAccessToken,
} from "../../services/tokens.js";
import { writeAudit } from "../../services/audit.js";
import { getPool } from "../../db/pool.js";
import { sha256 } from "../../lib/hash.js";

/**
 * Клиент называет себя заголовком X-Client-Id. Публичному клиенту
 * скрывать нечего: секрета у него нет и быть не может.
 */
export function clientIdOf(req: FastifyRequest): string | undefined {
  const header = req.headers["x-client-id"];
  return typeof header === "string" && header ? header : undefined;
}

/**
 * Первичный токен-API доступен ТОЛЬКО клиентам с first_party = true
 * (12_NATIVE_AUTH.md §3.1). Всем остальным — OIDC.
 *
 * Забыть эту проверку значит отдать всем желающим вход, спроектированный
 * в расчёте на доверенное приложение. Поэтому она стоит первой строкой
 * на всей группе /v1/auth/*, а не в каждой ручке по отдельности.
 */
export async function firstPartyGate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!(await isFirstParty(clientIdOf(req)))) {
    await writeAudit({ event: "first_party_denied", outcome: "fail", ip: req.ip });
    await reply.code(403).send({ error: "forbidden_client" });
  }
}

interface RefreshBody { refresh_token?: string }
interface LogoutBody { refresh_token?: string }

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/v1/auth/")) await firstPartyGate(req, reply);
  });

  /**
   * Ротация. Refresh всегда новый; приход потраченного гасит цепочку
   * устройства целиком и требует нового входа.
   */
  app.post("/v1/auth/token/refresh", async (req, reply) => {
    const body = (req.body ?? {}) as RefreshBody;
    if (!body.refresh_token) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const pair = await rotateRefresh(body.refresh_token);
      await writeAudit({ event: "token_refresh", outcome: "ok", ip: req.ip });
      return reply.send({
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
        expires_in: pair.expires_in,
      });
    } catch (e) {
      await writeAudit({ event: "token_refresh", outcome: "fail", ip: req.ip });
      if (e instanceof TokenError) {
        // Ответ один на все причины: различать «повтор обнаружен» и
        // «токена нет» значит подсказывать тому, кто подбирает.
        return reply.code(400).send({ error: "invalid_grant" });
      }
      throw e;
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const body = (req.body ?? {}) as LogoutBody;
    if (!body.refresh_token) return reply.code(204).send();
    const { rows } = await getPool().query<{ session_id: string; account_id: string }>(
      // Хеш считается в одном месте — lib/hash.ts. Второй путь
      // вычисления того же значения рано или поздно разойдётся с первым.
      `SELECT session_id, account_id FROM first_party_sessions
       WHERE refresh_hash = $1`,
      [sha256(body.refresh_token)],
    );
    const row = rows[0];
    if (row) {
      await revokeSession(row.account_id, row.session_id, "user_logout");
      await writeAudit({
        accountId: row.account_id, event: "logout", outcome: "ok", ip: req.ip,
      });
    }
    // 204 в любом случае: чужой или уже погашенный токен не повод
    // рассказывать, существовал ли он.
    return reply.code(204).send();
  });

  /**
   * Состав способов входа приходит с сервера, а не из сборки:
   * приложение не должно показывать кнопку в пустоту.
   *
   * На мобильной платформе провайдер показывается ТОЛЬКО если у него
   * подключён и проверен нативный SDK (12_NATIVE_AUTH.md §2.2).
   * Нет SDK — провайдера на экране нет, и это не ошибка, а следствие
   * требования.
   */
  app.get("/v1/auth/methods", async (req, reply) => {
    const platform = String(
      (req.query as Record<string, unknown> | undefined)?.platform ?? "web",
    );
    const { availableProviders } = await import("../../services/providers/native.js");
    return reply.send({
      email: true,
      providers: await availableProviders(platform),
    });
  });
}

/** Доступно и снаружи: экран входа спрашивает то же самое. */
export async function currentSessionOf(token: string): Promise<string | null> {
  const claims = await verifyAccessToken(token);
  return claims?.sessionId ?? null;
}

export { issueTokens };
