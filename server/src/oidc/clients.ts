import { randomBytes } from "node:crypto";
import { getPool } from "../db/pool.js";
import type { Product } from "../services/accounts.js";

export interface ClientRecord {
  clientId: string;
  clientName: string;
  clientSecret: string | null;
  redirectUris: string[];
  postLogoutUris: string[];
  grantTypes: string[];
  authMethod: "client_secret_basic" | "client_secret_post" | "none";
  firstParty: boolean;
  product: Product | null;
}

function toRecord(r: Record<string, unknown>): ClientRecord {
  return {
    clientId: r.client_id as string,
    clientName: r.client_name as string,
    clientSecret: (r.client_secret as string | null) ?? null,
    redirectUris: (r.redirect_uris as string[]) ?? [],
    postLogoutUris: (r.post_logout_uris as string[]) ?? [],
    grantTypes: (r.grant_types as string[]) ?? [],
    authMethod: r.auth_method as ClientRecord["authMethod"],
    firstParty: r.first_party as boolean,
    product: (r.product as Product | null) ?? null,
  };
}

export async function listClients(): Promise<ClientRecord[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM oidc_clients WHERE disabled_at IS NULL ORDER BY client_id",
  );
  return rows.map(toRecord);
}

export async function findClient(clientId: string): Promise<ClientRecord | null> {
  const { rows } = await getPool().query(
    "SELECT * FROM oidc_clients WHERE client_id = $1 AND disabled_at IS NULL",
    [clientId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Первичный токен-API открыт только своим клиентам (12_NATIVE_AUTH.md §3.1). */
export async function isFirstParty(clientId: string | undefined): Promise<boolean> {
  if (!clientId) return false;
  const client = await findClient(clientId);
  return client?.firstParty === true;
}

export interface NewClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  product?: Product | null;
  postLogoutUris?: string[];
  /** Публичный клиент (мобильный): без ключа, безопасность на PKCE. */
  isPublic?: boolean;
  /** Доступ к первичному токен-API. По умолчанию НЕТ. */
  firstParty?: boolean;
}

/**
 * Адрес возврата проверяется до записи, а не при первом входе.
 *
 * Кривой адрес, принятый молча, оборачивается отказом входа у живого
 * человека — и разбираться будут не с реестром, а с «вход не работает».
 * Фрагмент запрещён спецификацией OAuth: код в него не передать.
 * http допускается только для localhost — иначе код авторизации поедет
 * по открытому каналу.
 */
function checkRedirect(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`адрес возврата не разбирается: ${uri}`);
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.hash) throw new Error(`адрес возврата содержит фрагмент: ${uri}`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new Error(`адрес возврата не по https: ${uri}`);
  }
}

/**
 * Регистрация клиента. Ключ возвращается ОДИН раз — здесь; в журнал
 * он не пишется и повторно не показывается (артборд R4).
 */
export async function createClient(input: NewClient): Promise<ClientRecord> {
  const isPublic = input.isPublic === true;
  if (!isPublic && input.redirectUris.length === 0) {
    throw new Error("нужен хотя бы один адрес возврата");
  }
  for (const uri of input.redirectUris) checkRedirect(uri);

  const secret = isPublic ? null : generateClientSecret();
  const authMethod = isPublic ? "none" : "client_secret_basic";

  if (await findClient(input.clientId)) {
    throw new Error(`клиент ${input.clientId} уже зарегистрирован`);
  }

  const { rows } = await getPool().query(
    `INSERT INTO oidc_clients
       (client_id, client_name, client_secret, redirect_uris, post_logout_uris,
        auth_method, first_party, product)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.clientId, input.clientName, secret,
      input.redirectUris, input.postLogoutUris ?? [],
      authMethod,
      // Умолчание — НЕТ. Первичный токен-API открыт только тем, кого
      // назвали явно: забыть эту проверку значит отдать всем желающим
      // вход, спроектированный в расчёте на доверенное приложение.
      input.firstParty === true,
      input.product ?? null,
    ],
  );
  return toRecord(rows[0]!);
}

/** Ключ показывается один раз при выдаче — артборд R4. */
export function generateClientSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Перевод записи реестра в вид, который ждёт oidc-provider. */
export function toProviderClient(c: ClientRecord): Record<string, unknown> {
  return {
    client_id: c.clientId,
    client_name: c.clientName,
    client_secret: c.clientSecret ?? undefined,
    redirect_uris: c.redirectUris,
    post_logout_redirect_uris: c.postLogoutUris,
    grant_types: c.grantTypes,
    response_types: c.grantTypes.includes("authorization_code") ? ["code"] : [],
    token_endpoint_auth_method: c.authMethod,
  };
}
