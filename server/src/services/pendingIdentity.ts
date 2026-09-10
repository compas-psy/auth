import { getPool, withTransaction } from "../db/pool.js";
import type { Provider } from "./accounts.js";

/**
 * Личность провайдера, ждущая подтверждения почты.
 *
 * Провайдер не дал подтверждённого адреса — учётную запись заводить
 * нельзя (И-5), человек уходит на экран «Нужна электронная почта».
 * Личность при этом НЕ теряется: иначе, подтвердив почту, человек при
 * следующем входе тем же провайдером снова окажется на том же экране.
 *
 * Живёт столько же, сколько попытка входа, и гасится при первом
 * использовании.
 */
const TTL_MINUTES = 15;

export interface PendingIdentity {
  provider: Provider;
  subject: string;
  claimedEmail: string | null;
}

export async function rememberPendingIdentity(
  interactionUid: string,
  identity: PendingIdentity,
): Promise<void> {
  await getPool().query(
    `INSERT INTO pending_identities
       (interaction_uid, provider, subject, claimed_email, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5::int))
     ON CONFLICT (interaction_uid) DO UPDATE
       SET provider = EXCLUDED.provider,
           subject = EXCLUDED.subject,
           claimed_email = EXCLUDED.claimed_email,
           expires_at = EXCLUDED.expires_at,
           used_at = NULL`,
    [interactionUid, identity.provider, identity.subject, identity.claimedEmail, TTL_MINUTES],
  );
}

/** Забирает и гасит: повторно та же личность не всплывёт. */
export async function takePendingIdentity(
  interactionUid: string,
): Promise<PendingIdentity | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string; provider: Provider; subject: string; claimed_email: string | null;
    }>(
      `SELECT id, provider, subject, claimed_email FROM pending_identities
       WHERE interaction_uid = $1 AND used_at IS NULL AND expires_at > now()
       FOR UPDATE SKIP LOCKED`,
      [interactionUid],
    );
    const row = rows[0];
    if (!row) return null;
    await client.query("UPDATE pending_identities SET used_at = now() WHERE id = $1", [row.id]);
    return { provider: row.provider, subject: row.subject, claimedEmail: row.claimed_email };
  });
}

export async function purgePendingIdentities(): Promise<number> {
  const { rowCount } = await getPool().query(
    "DELETE FROM pending_identities WHERE expires_at < now() - interval '1 day'");
  return rowCount ?? 0;
}

/**
 * Привязка личности к УЖЕ СУЩЕСТВУЮЩЕЙ учётной записи.
 *
 * Отличается от linkOrCreateByProvider тем, что ничего не заводит:
 * запись уже есть, человек только что подтвердил её почту.
 *
 * Если эта личность провайдера принадлежит другому человеку — не
 * трогаем ничего. Молча перепривязать значило бы соединить две личности
 * по слову провайдера.
 */
export async function attachIdentity(
  accountId: string,
  identity: PendingIdentity,
  claimedEmail: string,
): Promise<"linked" | "taken" | "already"> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ account_id: string }>(
      "SELECT account_id FROM identities WHERE provider = $1 AND subject = $2",
      [identity.provider, identity.subject],
    );
    const owner = rows[0]?.account_id;
    if (owner) return owner === accountId ? "already" : "taken";

    await client.query(
      `INSERT INTO identities (account_id, provider, subject, email_at_link)
       VALUES ($1,$2,$3,$4)`,
      [accountId, identity.provider, identity.subject, claimedEmail],
    );
    return "linked";
  });
}
