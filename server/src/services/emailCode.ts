import { randomInt } from "node:crypto";
import { getPool, withTransaction } from "../db/pool.js";
import { sha256 } from "../lib/hash.js";
import { createAccountWithEmail, findAccountByEmail } from "./accounts.js";
import { THROTTLE_SECONDS, platformToSource } from "./magicLink.js";
import { currentDocument, recordConsent } from "./consents.js";

/** Десять минут, а не пятнадцать: код короче ссылки (12_NATIVE_AUTH.md §2.1). */
export const CODE_TTL_MINUTES = 10;
/** Пять попыток. Шестая гасит код безвозвратно. */
export const MAX_ATTEMPTS = 5;

export interface IssueCodeInput {
  email: string;
  deviceKey: string;
  platform: string;
  termsVersion?: string;
  marketingOptIn?: boolean;
}

export type IssueCodeResult =
  | { code: string; expiresInMinutes: number }
  | { throttled: true; retryAfterSeconds: number };

export type VerifyResult =
  | { accountId: string; created: boolean }
  | { error: "invalid_code"; attemptsLeft: number }
  | { error: "too_many_attempts" };

/**
 * Код — шесть цифр из randomInt (node:crypto). Math.random здесь был бы
 * предсказуем, а своего генератора мы не пишем.
 */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function issueEmailCode(i: IssueCodeInput): Promise<IssueCodeResult> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM magic_link_tokens
     WHERE lower(email) = lower($1)
       AND created_at > now() - make_interval(secs => $2::bigint)
     LIMIT 1`,
    [i.email, THROTTLE_SECONDS],
  );
  if (rows.length) return { throttled: true, retryAfterSeconds: THROTTLE_SECONDS };

  const code = newCode();
  await getPool().query(
    `INSERT INTO magic_link_tokens
       (email, token_hash, device_key, platform, terms_version, marketing_opt_in,
        kind, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'code', now() + make_interval(mins => $7::int))`,
    [i.email, hashCode(i.email, code), i.deviceKey, i.platform,
     i.termsVersion ?? null, i.marketingOptIn ?? false, CODE_TTL_MINUTES],
  );
  return { code, expiresInMinutes: CODE_TTL_MINUTES };
}

/**
 * Код солится адресом: иначе один и тот же шестизначный код у двух
 * человек даёт одинаковый хеш, а уникальный индекс по token_hash
 * отвергал бы вторую выдачу — то есть чужой вход мешал бы своему.
 */
function hashCode(email: string, code: string): string {
  return sha256(`${email.toLowerCase()}:${code}`);
}

type Claimed = {
  ok: true;
  email: string;
  termsVersion: string | null;
  marketingOptIn: boolean;
  platform: string;
};
type Rejected = { error: "invalid_code"; attemptsLeft: number } | { error: "too_many_attempts" };

export async function verifyEmailCode(i: {
  email: string;
  code: string;
  deviceKey: string;
}): Promise<VerifyResult> {
  const outcome = await withTransaction<Claimed | Rejected>(async (client) => {
    // Строка ищется по адресу и устройству, а не по коду: иначе
    // неверный код не с чем сопоставить, и счётчик попыток некуда
    // писать — перебор становится бесплатным.
    const { rows } = await client.query<{
      id: string; email: string; token_hash: string; attempts: number;
      terms_version: string | null; marketing_opt_in: boolean; platform: string;
      expired: boolean; used_at: Date | null; burned_at: Date | null;
    }>(
      // Погашенная строка НЕ исключается: иначе после гашения ответ
      // сваливался бы в «неверный код», и человек, исчерпавший попытки,
      // не узнал бы, что нужен новый код.
      `SELECT id, email, token_hash, attempts, terms_version, marketing_opt_in,
              platform, used_at, burned_at, (expires_at <= now()) AS expired
       FROM magic_link_tokens
       WHERE lower(email) = lower($1) AND device_key = $2 AND kind = 'code'
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [i.email, i.deviceKey],
    );
    const row = rows[0];
    // Погашенный код называется погашенным — и это не оракул: чтобы
    // сюда попасть, надо было уже пять раз ошибиться на этом же адресе
    // и устройстве, то есть узнать нечего.
    if (row?.burned_at) return { error: "too_many_attempts" };

    // Строки нет, она просрочена или уже использована — ответ такой же
    // по форме, как при неверном коде: разница была бы оракулом,
    // подсказывающим перебирающему, что он на верном адресе.
    if (!row || row.expired || row.used_at) {
      return { error: "invalid_code", attemptsLeft: MAX_ATTEMPTS };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await client.query(
        "UPDATE magic_link_tokens SET burned_at = now() WHERE id = $1", [row.id]);
      return { error: "too_many_attempts" };
    }

    if (row.token_hash !== hashCode(row.email, i.code)) {
      const attempts = row.attempts + 1;
      await client.query(
        `UPDATE magic_link_tokens
         SET attempts = $2::int,
             burned_at = CASE WHEN $2::int >= $3::int THEN now() ELSE NULL END
         WHERE id = $1`,
        [row.id, attempts, MAX_ATTEMPTS],
      );
      return { error: "invalid_code", attemptsLeft: MAX_ATTEMPTS - attempts };
    }

    await client.query("UPDATE magic_link_tokens SET used_at = now() WHERE id = $1", [row.id]);
    return {
      ok: true,
      email: row.email,
      termsVersion: row.terms_version,
      marketingOptIn: row.marketing_opt_in,
      platform: row.platform,
    };
  });

  if ("error" in outcome) return outcome;

  const existing = await findAccountByEmail(outcome.email);
  if (existing) return { accountId: existing.accountId, created: false };

  const { accountId } = await createAccountWithEmail(outcome.email);
  if (outcome.termsVersion) {
    const doc = await currentDocument("cmpas_terms");
    if (doc && doc.version === outcome.termsVersion) {
      await recordConsent({
        accountId,
        documentCode: doc.code,
        documentVersion: doc.version,
        contentHash: doc.contentHash,
        status: "granted",
        action: "signin_button",
        source: platformToSource(outcome.platform),
      });
    }
  }
  return { accountId, created: true };
}
