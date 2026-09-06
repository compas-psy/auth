import type { FastifyInstance } from "fastify";
import { getPool, withTransaction } from "../../db/pool.js";
import { PROVIDERS, type Provider } from "../../services/accounts.js";
import { writeAudit } from "../../services/audit.js";
import { requireCaller } from "./auth-guard.js";

interface IdentityRow {
  id: string;
  provider: Provider;
  linked_at: Date;
  last_login_at: Date | null;
}

function toIdentity(r: IdentityRow): Record<string, unknown> {
  return {
    id: r.id,
    provider: r.provider,
    linked_at: r.linked_at.toISOString(),
    last_login_at: r.last_login_at ? r.last_login_at.toISOString() : null,
  };
}

async function identityList(accountId: string): Promise<{ identities: unknown[] }> {
  const { rows } = await getPool().query<IdentityRow>(
    `SELECT id, provider, linked_at, last_login_at FROM identities
     WHERE account_id = $1 ORDER BY linked_at ASC`,
    [accountId],
  );
  return { identities: rows.map(toIdentity) };
}

export async function registerIdentityRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireCaller(app);

  app.get("/v1/account/identities", { onRequest: guard }, async (req, reply) =>
    reply.send(await identityList(req.caller!.accountId)));

  /**
   * Привязка возможна только при действующей сессии владельца: гвардия
   * стоит на маршруте, и account_id берётся из ключа, а не из тела.
   */
  app.post<{ Params: { provider: string } }>(
    "/v1/account/identities/:provider/link",
    { onRequest: guard },
    async (req, reply) => {
      const provider = req.params.provider as Provider;
      if (!PROVIDERS.includes(provider)) {
        return reply.code(400).send({ error: "unknown_provider" });
      }
      const body = (req.body ?? {}) as { subject?: string; email_at_link?: string | null };
      if (!body.subject) return reply.code(400).send({ error: "invalid_request" });

      const accountId = req.caller!.accountId;
      try {
        const { rows } = await getPool().query<IdentityRow>(
          `INSERT INTO identities (account_id, provider, subject, email_at_link)
           VALUES ($1,$2,$3,$4)
           RETURNING id, provider, linked_at, last_login_at`,
          [accountId, provider, body.subject, body.email_at_link ?? null],
        );
        await writeAudit({ accountId, event: "identity_linked", provider, outcome: "ok", ip: req.ip });
        return reply.send(toIdentity(rows[0]!));
      } catch (e) {
        // У-2: один аккаунт внешнего сервиса — одна учётная запись.
        // Уникальность держит база; здесь только перевод в ответ.
        if (isUniqueViolation(e)) {
          await writeAudit({ accountId, event: "identity_link", provider, outcome: "fail", ip: req.ip });
          return reply.code(409).send({ error: "identity_taken" });
        }
        throw e;
      }
    },
  );

  app.delete<{ Params: { identity_id: string } }>(
    "/v1/account/identities/:identity_id",
    { onRequest: guard },
    async (req, reply) => {
      const accountId = req.caller!.accountId;
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; provider: Provider }>(
          `SELECT id, provider FROM identities WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [req.params.identity_id, accountId],
        );
        const row = rows[0];
        if (!row) return { outcome: "not_found" as const };

        // И-5: внешний способ входа не может быть единственным. Отказ
        // приходит ОТ СЕРВЕРА (тест Т6), а не прячется в интерфейсе:
        // кнопка не может быть просто неактивной.
        const { rows: emails } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM account_emails
           WHERE account_id = $1 AND verified_at IS NOT NULL`,
          [accountId],
        );
        if ((emails[0]?.n ?? 0) === 0) {
          return { outcome: "last_login_method" as const };
        }
        await client.query("DELETE FROM identities WHERE id = $1", [row.id]);
        return { outcome: "ok" as const, provider: row.provider };
      });

      if (result.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.outcome === "last_login_method") {
        return reply.code(409).send({ error: "last_login_method" });
      }
      await writeAudit({
        accountId, event: "identity_unlinked", provider: result.provider, outcome: "ok", ip: req.ip,
      });
      return reply.code(204).send();
    },
  );
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}
