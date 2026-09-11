import { getPool, withTransaction } from "../db/pool.js";

export type Product = "practice" | "zapiski" | "moments" | "steps";
export const PRODUCTS: readonly Product[] = ["practice", "zapiski", "moments", "steps"];

export type Provider = "yandex" | "tid" | "sberid" | "vkid";
export const PROVIDERS: readonly Provider[] = ["yandex", "tid", "sberid", "vkid"];

export interface AccountRef {
  accountId: string;
}

/**
 * Заводит учётную запись с одной подтверждённой основной почтой.
 * Подтверждённой — потому что попасть сюда можно только погасив
 * магическую ссылку или код: владение адресом уже доказано.
 */
export async function createAccountWithEmail(
  email: string,
  opts: { displayName?: string | null } = {},
): Promise<AccountRef> {
  return withTransaction(async (client) => {
    const acc = await client.query<{ id: string }>(
      "INSERT INTO accounts (display_name) VALUES ($1) RETURNING id",
      [opts.displayName ?? null],
    );
    const accountId = acc.rows[0]!.id;
    await client.query(
      `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
       VALUES ($1, $2, now(), true)`,
      [accountId, email],
    );
    return { accountId };
  });
}

/**
 * Ищет действующую запись по подтверждённой почте.
 * Неподтверждённая почта входа не даёт: иначе достаточно было бы
 * заявить чужой адрес.
 */
export async function findAccountByEmail(email: string): Promise<AccountRef | null> {
  const { rows } = await getPool().query<{ account_id: string }>(
    `SELECT e.account_id
     FROM account_emails e
     JOIN accounts a ON a.id = e.account_id
     WHERE lower(e.email) = lower($1)
       AND e.verified_at IS NOT NULL
       AND a.status = 'active'`,
    [email],
  );
  return rows[0] ? { accountId: rows[0].account_id } : null;
}

/** Любая запись по адресу, включая неподтверждённую: нужна при добавлении почты. */
export async function findEmailOwner(
  email: string,
): Promise<{ accountId: string; verified: boolean } | null> {
  const { rows } = await getPool().query<{ account_id: string; verified: boolean }>(
    `SELECT account_id, (verified_at IS NOT NULL) AS verified
     FROM account_emails WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ? { accountId: rows[0].account_id, verified: rows[0].verified } : null;
}

export interface AccountProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: string;
  products: Product[];
}

export async function getAccountProfile(accountId: string): Promise<AccountProfile | null> {
  const { rows } = await getPool().query(
    `SELECT a.id, a.display_name, a.status, e.email, e.verified_at
     FROM accounts a
     LEFT JOIN account_emails e ON e.account_id = a.id AND e.is_primary
     WHERE a.id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email ?? "",
    emailVerified: row.verified_at !== null,
    displayName: row.display_name,
    status: row.status,
    products: await listProducts(accountId),
  };
}

export async function listProducts(accountId: string): Promise<Product[]> {
  const { rows } = await getPool().query<{ product: Product }>(
    "SELECT product FROM product_links WHERE account_id = $1 ORDER BY product",
    [accountId],
  );
  return rows.map((r) => r.product);
}

/**
 * Связывает учётную запись с пользователем продукта.
 * Идемпотентна: повторный вызов ничего не меняет. Занятый пользователь
 * продукта молча остаётся за прежним владельцем — перевешивать чужие
 * данные на другую личность эта операция не вправе.
 *
 * Сервис без опубликованных Особых условий не подключается вовсе
 * (13_LEGAL_CONSENT_CENTER_AUTH.md §5.3 и §8.5): подключение сервиса,
 * условий которого не существует, означает, что человек согласился с
 * тем, чего нет. Отказ приходит ОТ СЕРВЕРА — то же правило, по
 * которому сервер отказывает отвязать последний способ входа (И-5):
 * запрет, спрятанный в интерфейсе, обходится первым же прямым
 * запросом.
 */
export async function linkProduct(
  accountId: string,
  product: Product,
  productUserId: string,
): Promise<void> {
  const { rows } = await getPool().query<{ current_version: string | null }>(
    "SELECT current_version FROM legal_documents WHERE product = $1", [product]);
  if (!rows[0]?.current_version) {
    throw new Error(`сервис ${product} не подключается: Особые условия не опубликованы`);
  }
  await getPool().query(
    `INSERT INTO product_links (account_id, product, product_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [accountId, product, productUserId],
  );
}

export async function setDisplayName(
  accountId: string,
  displayName: string | null,
): Promise<void> {
  await getPool().query(
    "UPDATE accounts SET display_name = $2, updated_at = now() WHERE id = $1",
    [accountId, displayName],
  );
}
