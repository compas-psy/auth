import { getPool } from "../db/pool.js";

export type Channel = "email" | "push" | "messenger";
export const CHANNELS: readonly Channel[] = ["email", "push", "messenger"];

/** Каналы рекламных сообщений. SMS и звонков нет и не будет (задание 08 §1.3). */
export const MARKETING_CHANNELS: readonly Channel[] = ["email", "push"];
export const MARKETING_DOCUMENT = "cmpas_marketing_consent";

export type ConsentStatus = "granted" | "revoked";
export type ConsentSource = "web" | "android" | "desktop";

export interface ConsentInput {
  accountId: string;
  documentCode: string;
  documentVersion: string;
  contentHash: string;
  status: ConsentStatus;
  action: string;
  source: ConsentSource;
  channel?: Channel;
  ipHash?: string;
  uaHash?: string;
}

export interface ConsentState {
  documentCode: string;
  channel: string | null;
  status: ConsentStatus;
  since: string;
}

export interface AcceptedDocument {
  documentCode: string;
  title: string;
  version: string;
  acceptedAt: string;
  immutableUrl: string;
}

export async function recordConsent(i: ConsentInput): Promise<{ eventId: string }> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO consent_events
       (account_id, document_code, document_version, content_hash, status,
        action, source, channel, ip_hash, ua_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [i.accountId, i.documentCode, i.documentVersion, i.contentHash, i.status,
     i.action, i.source, i.channel ?? null, i.ipHash ?? null, i.uaHash ?? null],
  );
  return { eventId: rows[0]!.id };
}

/**
 * Действующее состояние — последнее событие по паре (документ, канал).
 * Кэша нет: журнал мал, а материализованная таблица consent_state из
 * 05_CONSENT_PDN.md §6.2 существует затем, чтобы её можно было
 * пересобрать из журнала целиком. Пока пересборка стоит один запрос,
 * второе хранилище того же факта — лишний источник расхождения.
 */
export async function effectiveState(accountId: string): Promise<ConsentState[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (document_code, channel)
            document_code, channel, status, occurred_at
     FROM consent_events
     WHERE account_id = $1
     ORDER BY document_code, channel, occurred_at DESC, seq DESC`,
    [accountId],
  );
  return rows.map((r) => ({
    documentCode: r.document_code,
    channel: r.channel,
    status: r.status,
    since: r.occurred_at.toISOString(),
  }));
}

/**
 * Состояние рекламных каналов, всегда полным списком: канал, по которому
 * событий не было, — «выключен». Пустой список на экране означал бы
 * «мы не знаем», а исходное состояние известно точно (задание 08 §2.1).
 */
export async function marketingState(
  accountId: string,
): Promise<Array<{ channel: Channel; status: ConsentStatus; since: string | null }>> {
  const state = await effectiveState(accountId);
  return MARKETING_CHANNELS.map((channel) => {
    const found = state.find(
      (s) => s.documentCode === MARKETING_DOCUMENT && s.channel === channel,
    );
    return {
      channel,
      status: found?.status ?? "revoked",
      since: found?.since ?? null,
    };
  });
}

/** Документы, принятые действием и не отозванные. Экран N1. */
export async function listAcceptedDocuments(accountId: string): Promise<AcceptedDocument[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (e.document_code)
            e.document_code, e.document_version, e.status, e.occurred_at,
            d.title, v.immutable_url
     FROM consent_events e
     JOIN legal_documents d ON d.code = e.document_code
     JOIN legal_document_versions v
       ON v.code = e.document_code AND v.version = e.document_version
     WHERE e.account_id = $1 AND e.channel IS NULL
     ORDER BY e.document_code, e.occurred_at DESC, e.seq DESC`,
    [accountId],
  );
  return rows
    .filter((r) => r.status === "granted")
    .map((r) => ({
      documentCode: r.document_code,
      title: r.title,
      version: r.document_version,
      acceptedAt: r.occurred_at.toISOString(),
      immutableUrl: r.immutable_url,
    }));
}

export interface PublishedDocument {
  code: string;
  title: string;
  acceptance: "action" | "consent" | "none";
  version: string;
  contentHash: string;
  immutableUrl: string;
  effectiveAt: string;
}

/** Действующая редакция документа. Версии и хеши берутся отсюда, не из вёрстки. */
export async function currentDocument(code: string): Promise<PublishedDocument | null> {
  const { rows } = await getPool().query(
    `SELECT d.code, d.title, d.acceptance, v.version, v.content_hash,
            v.immutable_url, v.effective_at
     FROM legal_documents d
     JOIN legal_document_versions v ON v.code = d.code AND v.version = d.current_version
     WHERE d.code = $1`,
    [code],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code,
    title: r.title,
    acceptance: r.acceptance,
    version: r.version,
    contentHash: r.content_hash,
    immutableUrl: r.immutable_url,
    effectiveAt: r.effective_at.toISOString(),
  };
}

/**
 * «Отключить всю рекламу» (артборд M3): отзыв по каждому действующему
 * каналу отдельной записью. Одной строкой «выключено всё» обойтись
 * нельзя — отзыв по каналу это отдельный юридический факт.
 */
export async function revokeAllMarketing(
  accountId: string,
  ctx: { source: ConsentSource; ipHash?: string; uaHash?: string },
): Promise<{ revoked: Channel[] }> {
  const doc = await currentDocument(MARKETING_DOCUMENT);
  if (!doc) throw new Error("marketing consent document is not published");
  const state = await marketingState(accountId);
  const revoked: Channel[] = [];
  for (const c of state) {
    if (c.status !== "granted") continue;
    await recordConsent({
      accountId,
      documentCode: MARKETING_DOCUMENT,
      documentVersion: doc.version,
      contentHash: doc.contentHash,
      status: "revoked",
      action: "revoke_all_marketing",
      source: ctx.source,
      channel: c.channel,
      ipHash: ctx.ipHash,
      uaHash: ctx.uaHash,
    });
    revoked.push(c.channel);
  }
  return { revoked };
}
