/**
 * Клиент публичного API v1.
 *
 * Портал ходит ТОЛЬКО сюда, и здесь — только те пути, что объявлены в
 * server/openapi/simpasid.v1.yaml. Отдельного внутреннего пути для
 * наших собственных интерфейсов не существует; если чего-то нет в
 * спецификации — этого не может быть и на экране.
 *
 * Перечень ниже объявлен явно, чтобы его можно было сверить со
 * спецификацией машинно, а не глазами.
 */
export const API_CALLS = [
  "/account",
  "/account/emails",
  "/account/emails/{email_id}",
  "/account/emails/{email_id}/primary",
  "/account/identities",
  "/account/identities/{provider}/link",
  "/account/identities/{identity_id}",
  "/account/sessions",
  "/account/sessions/{session_id}",
  "/account/sessions/revoke-others",
  "/account/consents",
  "/account/consents/revoke-all-marketing",
  "/account/audit",
] as const;

const BASE = "/v1";

import { currentToken, forgetToken } from "../auth/oidc";

export interface Account {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  products: Array<"practice" | "zapiski" | "moments">;
}

export interface Email {
  id: string;
  email: string;
  verified: boolean;
  is_primary: boolean;
  added_at?: string;
}

export interface Identity {
  id: string;
  provider: "yandex" | "tid" | "sberid" | "vkid";
  linked_at: string;
  last_login_at: string | null;
}

export interface Session {
  id: string;
  current: boolean;
  platform: string | null;
  client: string | null;
  last_seen_at: string;
}

export interface Communication {
  channel: "email" | "push";
  status: "granted" | "revoked";
  since: string | null;
}

export interface AcceptedDocument {
  document_code: string;
  title: string;
  version: string;
  accepted_at: string;
  url: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Ключ доступа, а не cookie. API принимает только Bearer, и портал
  // ходит туда же и тем же способом, что и продукты: отдельного
  // внутреннего пути для наших интерфейсов не существует.
  const token = currentToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  // Ключ протух или отозван — он больше не годится ни для чего.
  if (res.status === 401) forgetToken();
  if (!res.ok) {
    let code = "request_failed";
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* тело не разобралось — код отказа остаётся общим */
    }
    throw new ApiError(res.status, code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  getAccount: () => request<Account>("/account"),
  setDisplayName: (displayName: string | null) =>
    request<Account>("/account", {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName }),
    }),

  listEmails: () => request<{ emails: Email[] }>("/account/emails"),
  addEmail: (email: string) =>
    request<{ status: string }>("/account/emails", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  makeEmailPrimary: (id: string) =>
    request<{ emails: Email[] }>(`/account/emails/${encodeURIComponent(id)}/primary`, {
      method: "POST",
    }),
  deleteEmail: (id: string) =>
    request<void>(`/account/emails/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listIdentities: () => request<{ identities: Identity[] }>("/account/identities"),
  unlinkIdentity: (id: string) =>
    request<void>(`/account/identities/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listSessions: () => request<{ sessions: Session[] }>("/account/sessions"),
  revokeSession: (id: string) =>
    request<void>(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokeOtherSessions: () =>
    request<{ revoked: number }>("/account/sessions/revoke-others", { method: "POST" }),

  getConsents: () =>
    request<{ communications: Communication[]; accepted_documents: AcceptedDocument[] }>(
      "/account/consents",
    ),
  setConsent: (input: {
    document_code: string; version: string; channel?: string;
    status: "granted" | "revoked"; action: string;
  }) =>
    request<{ communications: Communication[]; accepted_documents: AcceptedDocument[] }>(
      "/account/consents",
      { method: "PUT", body: JSON.stringify(input) },
    ),
  revokeAllMarketing: () =>
    request<{ communications: Communication[]; accepted_documents: AcceptedDocument[] }>(
      "/account/consents/revoke-all-marketing",
      { method: "POST" },
    ),
};
