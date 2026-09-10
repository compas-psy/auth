import { randomBytes } from "node:crypto";
import { getPool, withTransaction } from "../db/pool.js";
import { sha256 } from "../lib/hash.js";
import { createAccountWithEmail, findAccountByEmail } from "./accounts.js";
import { currentDocument, recordConsent, type ConsentSource } from "./consents.js";

/** Ссылка живёт 15 минут и открывается один раз — так сказано человеку на B2. */
export const LINK_TTL_MINUTES = 15;
/** Пауза считается СЕРВЕРОМ: таймер в интерфейсе не защищает ни от чего. */
export const THROTTLE_SECONDS = 60;

export type Platform = "web" | "android" | "desktop";

export interface IssueInput {
  email: string;
  deviceKey: string;
  platform: Platform | string;
  /** Редакция соглашения, принятая действием на экране входа. */
  termsVersion?: string;
  marketingOptIn?: boolean;
  /**
   * Личность провайдера, ждущая подтверждения почты (И-5).
   *
   * Едет ВМЕСТЕ С ТОКЕНОМ, а не остаётся привязанной к попытке входа:
   * человек может открыть ссылку в другой вкладке или на другом
   * устройстве, и связь с попыткой там уже не поможет.
   */
  pendingIdentity?: { provider: string; subject: string };
}

export type IssueResult =
  | { token: string; expiresInMinutes: number }
  | { throttled: true; retryAfterSeconds: number };

export interface RedeemResult {
  accountId: string;
  /** true, если этот вход завёл учётную запись. Нужен экрану D1. */
  created: boolean;
  /** Личность провайдера, которую надо привязать после подтверждения. */
  pendingIdentity?: { provider: string; subject: string };
  /** Адрес, который человек подтвердил этой ссылкой. */
  email: string;
}

/**
 * Выпускает магическую ссылку. Форма ответа одинакова для известного и
 * неизвестного адреса: разные ответы превращают ручку в способ узнать,
 * зарегистрирован ли человек в сервисе психологической помощи.
 */
export async function issueMagicLink(i: IssueInput): Promise<IssueResult> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM magic_link_tokens
     WHERE lower(email) = lower($1)
       AND created_at > now() - make_interval(secs => $2::bigint)
     LIMIT 1`,
    [i.email, THROTTLE_SECONDS],
  );
  if (rows.length) return { throttled: true, retryAfterSeconds: THROTTLE_SECONDS };

  // 32 случайных байта из node:crypto. Своего генератора нет.
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO magic_link_tokens
       (email, token_hash, device_key, platform, terms_version, marketing_opt_in,
        pending_provider, pending_subject, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9::int))`,
    [i.email, sha256(token), i.deviceKey, i.platform,
     i.termsVersion ?? null, i.marketingOptIn ?? false,
     i.pendingIdentity?.provider ?? null, i.pendingIdentity?.subject ?? null,
     LINK_TTL_MINUTES],
  );
  return { token, expiresInMinutes: LINK_TTL_MINUTES };
}

/**
 * Гасит ссылку и возвращает личность. Первое погашение заводит учётную
 * запись: владение адресом доказано переходом по ссылке, и почта сразу
 * подтверждённая.
 */
export async function redeemMagicLink(
  token: string,
  ctx: { source?: ConsentSource; ipHash?: string; uaHash?: string } = {},
): Promise<RedeemResult | null> {
  // Гашение и проверка — в одной транзакции с блокировкой строки:
  // две вкладки, открывшие письмо одновременно, не должны дать
  // ни двух входов, ни двух учётных записей.
  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string; email: string; terms_version: string | null;
      marketing_opt_in: boolean; platform: string;
      pending_provider: string | null; pending_subject: string | null;
    }>(
      `SELECT id, email, terms_version, marketing_opt_in, platform,
              pending_provider, pending_subject
       FROM magic_link_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       FOR UPDATE SKIP LOCKED`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) return null;
    await client.query("UPDATE magic_link_tokens SET used_at = now() WHERE id = $1", [row.id]);
    return row;
  });
  if (!claimed) return null;

  // Личность провайдера, ждущая подтверждения, возвращается наверх:
  // привязывает её маршрут, потому что только он знает, чем ответить
  // человеку, если эта личность занята другим (артборд C3).
  const pendingIdentity = claimed.pending_provider && claimed.pending_subject
    ? { provider: claimed.pending_provider, subject: claimed.pending_subject }
    : undefined;

  const existing = await findAccountByEmail(claimed.email);
  if (existing) {
    return { accountId: existing.accountId, created: false, pendingIdentity, email: claimed.email };
  }

  const { accountId } = await createAccountWithEmail(claimed.email);
  await recordAcceptance(accountId, claimed, ctx);
  return { accountId, created: true, pendingIdentity, email: claimed.email };
}

/**
 * Акцепт действием: человек нажал «Получить ссылку для входа», и на
 * экране прямо сказано, какую редакцию он принимает. Записывается один
 * раз — при создании учётной записи, потому что раньше записать некуда.
 */
async function recordAcceptance(
  accountId: string,
  claimed: { terms_version: string | null; marketing_opt_in: boolean; platform: string },
  ctx: { source?: ConsentSource; ipHash?: string; uaHash?: string },
): Promise<void> {
  if (!claimed.terms_version) return;
  const doc = await currentDocument("cmpas_terms");
  if (!doc || doc.version !== claimed.terms_version) return;
  const source = ctx.source ?? platformToSource(claimed.platform);
  await recordConsent({
    accountId,
    documentCode: "cmpas_terms",
    documentVersion: doc.version,
    contentHash: doc.contentHash,
    status: "granted",
    action: "signin_button",
    source,
    ipHash: ctx.ipHash,
    uaHash: ctx.uaHash,
  });
  // Рекламное согласие — отдельная запись, по каналу, и только если
  // человек сам включил переключатель. Объединять его с акцептом
  // соглашения запрещено (CMPAS_LEGAL_IMPLEMENTATION.md §21).
  if (claimed.marketing_opt_in) {
    const marketing = await currentDocument("cmpas_marketing_consent");
    if (marketing) {
      await recordConsent({
        accountId,
        documentCode: marketing.code,
        documentVersion: marketing.version,
        contentHash: marketing.contentHash,
        status: "granted",
        action: "switch_marketing_email",
        source,
        channel: "email",
        ipHash: ctx.ipHash,
        uaHash: ctx.uaHash,
      });
    }
  }
}

export function platformToSource(platform: string): ConsentSource {
  if (platform === "android") return "android";
  if (platform === "desktop") return "desktop";
  return "web";
}

/** Уборка: погашенное и просроченное не должно лежать вечно. */
export async function purgeMagicTokens(): Promise<number> {
  const { rowCount } = await getPool().query(
    "DELETE FROM magic_link_tokens WHERE expires_at < now() - interval '1 day'",
  );
  return rowCount ?? 0;
}
