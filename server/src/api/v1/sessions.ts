import type { FastifyInstance } from "fastify";
import { getPool } from "../../db/pool.js";
import { revokeSession, revokeOtherSessions } from "../../services/tokens.js";
import { writeAudit } from "../../services/audit.js";
import { requireCaller } from "./auth-guard.js";

interface SessionRow {
  id: string;
  platform: string | null;
  client: string | null;
  last_seen_at: Date;
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireCaller(app);

  /**
   * Устройства и сеансы (артборд L2).
   *
   * Решение П-2: platform и client отдаются огрублёнными — семейство
   * без версии. IP-адреса и точного устройства здесь нет и быть не
   * может: они не хранятся, и на экране прямо написано, почему.
   */
  app.get("/v1/account/sessions", { onRequest: guard }, async (req, reply) => {
    const { rows } = await getPool().query<SessionRow>(
      `SELECT id, platform, client, last_seen_at FROM sessions
       WHERE account_id = $1 AND revoked_at IS NULL
       ORDER BY last_seen_at DESC`,
      [req.caller!.accountId],
    );
    return reply.send({
      sessions: rows.map((r) => ({
        id: r.id,
        current: r.id === req.caller!.sessionId,
        platform: r.platform,
        client: r.client,
        last_seen_at: r.last_seen_at.toISOString(),
      })),
    });
  });

  app.delete<{ Params: { session_id: string } }>(
    "/v1/account/sessions/:session_id",
    { onRequest: guard },
    async (req, reply) => {
      const accountId = req.caller!.accountId;
      const done = await revokeSession(accountId, req.params.session_id, "user_revoked");
      if (!done) return reply.code(404).send({ error: "not_found" });
      await writeAudit({ accountId, event: "session_revoked", outcome: "ok", ip: req.ip });
      return reply.code(204).send();
    },
  );

  app.post("/v1/account/sessions/revoke-others", { onRequest: guard }, async (req, reply) => {
    const accountId = req.caller!.accountId;
    const revoked = await revokeOtherSessions(accountId, req.caller!.sessionId, "user_revoked_all");
    await writeAudit({ accountId, event: "sessions_revoked_others", outcome: "ok", ip: req.ip });
    return reply.send({ revoked });
  });
}
