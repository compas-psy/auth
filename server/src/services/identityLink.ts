import { getPool, withTransaction } from "../db/pool.js";
import { createAccountWithEmail, findAccountByEmail, type Provider } from "./accounts.js";

/**
 * Связывание внешнего способа входа с личностью.
 *
 * Правило слияния (02_SIMPASID.md §4.4): один человек с одной почтой —
 * одна учётная запись. Разные почты — разные люди, пока он сам не
 * привяжет вторую почту в настройках. Автоматическое слияние по имени,
 * телефону или платёжному профилю запрещено — да и нечем: этих полей
 * у нас нет.
 */
/**
 * Кому уже принадлежит эта личность провайдера.
 *
 * Нужно там, где провайдер НЕ дал подтверждённой почты. Если связь уже
 * есть, требование И-5 выполнено давно: учётная запись за этой связью
 * заведена только после подтверждения адреса. Гонять человека по кругу
 * через экран «Нужна электронная почта» при каждом входе значит
 * наказывать его за то, что провайдер не отдаёт признака подтверждения.
 */
export async function accountByIdentity(
  provider: Provider,
  subject: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ account_id: string }>(
    "SELECT account_id FROM identities WHERE provider = $1 AND subject = $2",
    [provider, subject],
  );
  return rows[0]?.account_id ?? null;
}

export async function linkOrCreateByProvider(i: {
  provider: Provider;
  subject: string;
  email: string;
}): Promise<{ accountId: string; created: boolean } | "identity_taken"> {
  const existingIdentity = await withTransaction(async (client) => {
    const { rows } = await client.query<{ account_id: string }>(
      `SELECT account_id FROM identities WHERE provider = $1 AND subject = $2`,
      [i.provider, i.subject],
    );
    return rows[0]?.account_id ?? null;
  });

  const byEmail = await findAccountByEmail(i.email);

  if (existingIdentity) {
    // Привязка уже есть. Пускаем по ней только если почта, которую
    // назвал провайдер, принадлежит ЭТОЙ же учётной записи.
    //
    // Иначе это артборд C3: аккаунт внешнего сервиса уже привязан к
    // другой учётной записи СИМПАС. Молча пустить — значит соединить
    // две личности по слову провайдера, а связывание по почте прямо
    // названо самым опасным местом (02_SIMPASID.md §5.3). Разбирает
    // человек, а не догадка сервера.
    if (byEmail?.accountId === existingIdentity) {
      await touchLogin(i.provider, i.subject);
      return { accountId: existingIdentity, created: false };
    }
    if (await emailBelongsTo(existingIdentity, i.email)) {
      await touchLogin(i.provider, i.subject);
      return { accountId: existingIdentity, created: false };
    }
    return "identity_taken";
  }

  if (byEmail) {
    const taken = await tryInsertIdentity(byEmail.accountId, i);
    return taken ? { accountId: byEmail.accountId, created: false } : "identity_taken";
  }

  const { accountId } = await createAccountWithEmail(i.email);
  const ok = await tryInsertIdentity(accountId, i);
  return ok ? { accountId, created: true } : "identity_taken";
}

async function tryInsertIdentity(
  accountId: string,
  i: { provider: Provider; subject: string; email: string },
): Promise<boolean> {
  try {
    await withTransaction((client) =>
      client.query(
        `INSERT INTO identities (account_id, provider, subject, email_at_link, last_login_at)
         VALUES ($1,$2,$3,$4, now())`,
        [accountId, i.provider, i.subject, i.email],
      ),
    );
    return true;
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      return false;
    }
    throw e;
  }
}

async function emailBelongsTo(accountId: string, email: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM account_emails
       WHERE account_id = $1 AND lower(email) = lower($2) AND verified_at IS NOT NULL`,
      [accountId, email],
    );
    return (rows[0]?.n ?? 0) > 0;
  });
}

async function touchLogin(provider: Provider, subject: string): Promise<void> {
  await withTransaction((client) =>
    client.query(
      "UPDATE identities SET last_login_at = now() WHERE provider = $1 AND subject = $2",
      [provider, subject],
    ),
  );
}
