import type { FastifyInstance } from "fastify";
import { listAudit } from "../../services/audit.js";
import { requireCaller } from "./auth-guard.js";

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireCaller(app);

  app.get("/v1/account/audit", { onRequest: guard }, async (req, reply) => {
    const raw = (req.query as Record<string, unknown> | undefined)?.limit;
    const limit = Number(raw ?? 50);
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const events = await listAudit(req.caller!.accountId, limit);
    return reply.send({ events });
  });
}
