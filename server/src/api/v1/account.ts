import type { FastifyInstance } from "fastify";
import { getPool, withTransaction } from "../../db/pool.js";
import {
  getAccountProfile, setDisplayName, findEmailOwner,
} from "../../services/accounts.js";
import { writeAudit } from "../../services/audit.js";
import { requireCaller } from "./auth-guard.js";
import { issueMagicLink } from "../../services/magicLink.js";
import { sendMagicLink } from "../../services/mailer.js";
import { loadConfig } from "../../config.js";

const MAX_DISPLAY_NAME = 100;

interface EmailRow {
  id: string;
  email: string;
  verified_at: Date | null;
  is_primary: boolean;
  added_at: Date;
}

function toEmail(r: EmailRow): Record<string, unknown> {
  return {
    id: r.id,
    email: r.email,
    verified: r.verified_at !== null,
    is_primary: r.is_primary,
    added_at: r.added_at.toISOString(),
  };
}

async function emailList(accountId: string): Promise<{ emails: unknown[] }> {
  const { rows } = await getPool().query<EmailRow>(
    `SELECT id, email, verified_at, is_primary, added_at FROM account_emails
     WHERE account_id = $1 ORDER BY is_primary DESC, added_at ASC`,
    [accountId],
  );
  return { emails: rows.map(toEmail) };
}

/**
 * Профиль отдаётся ровно теми полями, что объявлены в спецификации.
 * Лишнее поле здесь — это поле, которого нет в документации, то есть
 * ровно тот внутренний путь, которого не должно существовать.
 */
function toAccount(p: NonNullable<Awaited<ReturnType<typeof getAccountProfile>>>) {
  return {
    id: p.id,
    email: p.email,
    email_verified: p.emailVerified,
    display_name: p.displayName,
    products: p.products,
  };
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireCaller(app);

  app.get("/v1/account", { onRequest: guard }, async (req, reply) => {
    const profile = await getAccountProfile(req.caller!.accountId);
    if (!profile) return reply.code(401).send({ error: "unauthorized" });
    return reply.send(toAccount(profile));
  });

  app.patch("/v1/account", { onRequest: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as { display_name?: unknown };
    if (!("display_name" in body)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const value = body.display_name;
    if (value !== null && typeof value !== "string") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const trimmed = typeof value === "string" ? value.trim() : null;
    if (trimmed !== null && trimmed.length > MAX_DISPLAY_NAME) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    await setDisplayName(req.caller!.accountId, trimmed && trimmed.length ? trimmed : null);
    const profile = await getAccountProfile(req.caller!.accountId);
    return reply.send(toAccount(profile!));
  });

  app.get("/v1/account/emails", { onRequest: guard }, async (req, reply) =>
    reply.send(await emailList(req.caller!.accountId)));

  app.post("/v1/account/emails", { onRequest: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || !email.includes("@")) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const owner = await findEmailOwner(email);
    if (owner) {
      // Занят кем угодно, включая самого спрашивающего: в обоих случаях
      // добавлять нечего, и различать ответы значило бы рассказывать,
      // за кем адрес числится.
      return reply.code(409).send({ error: "email_taken" });
    }
    await getPool().query(
      `INSERT INTO account_emails (account_id, email, is_primary) VALUES ($1, $2, false)`,
      [req.caller!.accountId, email],
    );
    // Владение адресом доказывается тем же способом, что и при входе:
    // переходом по ссылке из письма. Второго механизма подтверждения нет.
    const issued = await issueMagicLink({
      email, deviceKey: `add-email:${req.caller!.accountId}`, platform: "web",
    });
    if (!("throttled" in issued)) {
      await sendMagicLink(email, `${loadConfig().issuer}/verify-email/${issued.token}`);
    }
    await writeAudit({
      accountId: req.caller!.accountId, event: "email_added", outcome: "ok", ip: req.ip,
    });
    return reply.code(202).send({ status: "sent" });
  });

  app.post<{ Params: { email_id: string } }>(
    "/v1/account/emails/:email_id/primary",
    { onRequest: guard },
    async (req, reply) => {
      const accountId = req.caller!.accountId;
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<EmailRow>(
          `SELECT id, email, verified_at, is_primary, added_at FROM account_emails
           WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [req.params.email_id, accountId],
        );
        const row = rows[0];
        // Чужая почта — 404, а не 403: существование чужой строки не наше
        // дело сообщать.
        if (!row) return "not_found" as const;
        if (!row.verified_at) return "email_not_verified" as const;
        await client.query(
          "UPDATE account_emails SET is_primary = false WHERE account_id = $1 AND is_primary",
          [accountId],
        );
        await client.query("UPDATE account_emails SET is_primary = true WHERE id = $1", [row.id]);
        return "ok" as const;
      });
      if (result === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result === "email_not_verified") {
        return reply.code(409).send({ error: "email_not_verified" });
      }
      await writeAudit({ accountId, event: "email_primary_changed", outcome: "ok", ip: req.ip });
      return reply.send(await emailList(accountId));
    },
  );

  app.delete<{ Params: { email_id: string } }>(
    "/v1/account/emails/:email_id",
    { onRequest: guard },
    async (req, reply) => {
      const accountId = req.caller!.accountId;
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<EmailRow>(
          `SELECT id, email, verified_at, is_primary, added_at FROM account_emails
           WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [req.params.email_id, accountId],
        );
        const row = rows[0];
        if (!row) return "not_found" as const;

        // И-5: у каждой учётной записи всегда есть подтверждённая почта.
        // Отказ приходит ОТ СЕРВЕРА, а не прячется в интерфейсе (тест Т6).
        const { rows: left } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM account_emails
           WHERE account_id = $1 AND verified_at IS NOT NULL AND id <> $2`,
          [accountId, row.id],
        );
        if (row.verified_at && (left[0]?.n ?? 0) === 0) return "last_login_method" as const;

        // Основную почту не удаляют, а меняют: «Её можно изменить, но не
        // удалить» (02_SIMPASID.md §7.6). Сначала другая делается основной.
        if (row.is_primary) return "primary_email" as const;

        await client.query("DELETE FROM account_emails WHERE id = $1", [row.id]);
        return "ok" as const;
      });
      if (result === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result !== "ok") return reply.code(409).send({ error: result });
      await writeAudit({ accountId, event: "email_removed", outcome: "ok", ip: req.ip });
      return reply.code(204).send();
    },
  );
}
