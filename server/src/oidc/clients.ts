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
