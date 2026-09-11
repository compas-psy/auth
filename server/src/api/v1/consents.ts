import type { FastifyInstance } from "fastify";
import {
  marketingState, listAcceptedDocuments, recordConsent, revokeAllMarketing,
  currentDocument, currentDocuments, MARKETING_CHANNELS, type Channel,
} from "../../services/consents.js";
import { writeAudit } from "../../services/audit.js";
import { requireCaller, requestContext } from "./auth-guard.js";
import { platformToSource } from "../../services/magicLink.js";
import { coarsen } from "../../lib/useragent.js";

async function state(accountId: string): Promise<Record<string, unknown>> {
  const [communications, accepted] = await Promise.all([
    marketingState(accountId),
    listAcceptedDocuments(accountId),
  ]);
  return {
    communications: communications.map((c) => ({
      channel: c.channel,
      status: c.status,
      since: c.since,
    })),
    accepted_documents: accepted.map((d) => ({
      document_code: d.documentCode,
      title: d.title,
      version: d.version,
      accepted_at: d.acceptedAt,
      // Ссылка ведёт на ПРИНЯТУЮ редакцию, а не на текущую
      // (CMPAS_LEGAL_IMPLEMENTATION.md §11).
      url: d.immutableUrl,
    })),
  };
}

export async function registerConsentRoutes(app: FastifyInstance): Promise<void> {
  const guard = requireCaller(app);

  /**
   * Действующие редакции документов. БЕЗ входа: это публичные
   * документы, и их читают до того, как человек завёл учётную запись.
   *
   * Отсюда продукт берёт номер редакции и адрес для строки «Начиная
   * работу, вы принимаете Особые условия ПРАКТИКИ, редакция 1.0».
   */
  app.get("/v1/legal/documents", async (_req, reply) => {
    const documents = await currentDocuments();
    return reply.send({
      documents: documents.map((d) => ({
        document_code: d.code,
        title: d.title,
        version: d.version,
        url: d.url,
        acceptance: d.acceptance,
        ...(d.product ? { product: d.product } : {}),
      })),
    });
  });

  app.get("/v1/account/consents", { onRequest: guard }, async (req, reply) =>
    reply.send(await state(req.caller!.accountId)));

  app.put("/v1/account/consents", { onRequest: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      document_code?: string; version?: string; channel?: string;
      status?: string; action?: string;
    };
    if (!body.document_code || !body.version || !body.action
        || (body.status !== "granted" && body.status !== "revoked")) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (body.channel && !MARKETING_CHANNELS.includes(body.channel as Channel)) {
      // SMS и звонков как канала не существует (задание 08 §1.3).
      return reply.code(400).send({ error: "unknown_channel" });
    }

    const doc = await currentDocument(body.document_code);
    if (!doc) return reply.code(400).send({ error: "unknown_document" });
    if (doc.version !== body.version) {
      // Согласие даётся на редакцию, которую человек ВИДЕЛ. Расхождение
      // означает, что экран показывал не то, что действует сейчас.
      return reply.code(409).send({ error: "stale_document_version" });
    }
    // Политика обработки персональных данных не принимается вовсе:
    // это информационный документ (юрпакет §3.2). Ручка, позволяющая
    // «принять» её, сама по себе была бы дефектом правовой конструкции.
    if (doc.acceptance === "none") {
      return reply.code(409).send({ error: "document_is_informational" });
    }

    const accountId = req.caller!.accountId;
    const ctx = requestContext(req);
    await recordConsent({
      accountId,
      documentCode: doc.code,
      documentVersion: doc.version,
      contentHash: doc.contentHash,
      status: body.status,
      action: body.action,
      source: platformToSource(coarsen(req.headers["user-agent"]).platform ?? "web"),
      channel: body.channel as Channel | undefined,
      ipHash: ctx.ipHash,
      uaHash: ctx.uaHash,
    });
    await writeAudit({ accountId, event: "consent_changed", outcome: "ok", ip: req.ip });
    return reply.send(await state(accountId));
  });

  /** Артборд M3. Отзыв по каждому каналу — отдельной записью журнала. */
  app.post("/v1/account/consents/revoke-all-marketing", { onRequest: guard },
    async (req, reply) => {
      const accountId = req.caller!.accountId;
      const ctx = requestContext(req);
      await revokeAllMarketing(accountId, {
        source: platformToSource(coarsen(req.headers["user-agent"]).platform ?? "web"),
        ipHash: ctx.ipHash,
        uaHash: ctx.uaHash,
      });
      await writeAudit({ accountId, event: "marketing_revoked_all", outcome: "ok", ip: req.ip });
      return reply.send(await state(accountId));
    });
}
