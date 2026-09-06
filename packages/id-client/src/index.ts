import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface SimpasClientOptions {
  /** Адрес сервиса. Всё остальное выводится из него через discovery. */
  issuer: string;
  clientId: string;
  /** Публичному клиенту секрет не нужен и не выдаётся: у него PKCE. */
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}

export interface AuthorizationUrlInput {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
  prompt?: string;
}

export interface TokenSet {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface SimpasAccount {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  products: string[];
}

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export class SimpasError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "SimpasError";
  }
}

/**
 * Пара для PKCE. Обязателен для ВСЕХ клиентов, включая серверные:
 * это требование сервиса, а не рекомендация.
 *
 * Своей криптографии здесь нет — node:crypto.
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Одноразовые state и nonce. Оба обязательны и оба проверяются. */
export function createState(): string {
  return randomBytes(16).toString("base64url");
}
export const createNonce = createState;

export interface SimpasClient {
  discover(): Promise<Discovery>;
  getAuthorizationUrl(input: AuthorizationUrlInput): Promise<string>;
  exchangeCode(input: {
    code: string; codeVerifier: string; redirectUri: string;
  }): Promise<TokenSet>;
  verifyIdToken(token: string, expected?: { nonce?: string }): Promise<IdTokenClaims>;
  getAccount(accessToken: string): Promise<SimpasAccount>;
  refresh(refreshToken: string): Promise<TokenSet>;
}

export function createSimpasClient(options: SimpasClientOptions): SimpasClient {
  const issuer = options.issuer.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  let discovery: Discovery | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  async function discover(): Promise<Discovery> {
    if (discovery) return discovery;
    // Адрес метаданных выводится из issuer — так же, как это делает
    // next-auth (packages/core/src/lib/utils/providers.ts).
    const res = await doFetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new SimpasError("не удалось прочитать метаданные", "discovery_failed", res.status);
    }
    discovery = (await res.json()) as Discovery;
    if (discovery.issuer !== issuer) {
      // Метаданные, называющие другой issuer, — это чужой сервис.
      throw new SimpasError("issuer в метаданных не совпадает", "issuer_mismatch");
    }
    return discovery;
  }

  function authHeader(): Record<string, string> {
    if (!options.clientSecret) return {};
    const basic = Buffer.from(
      `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
    ).toString("base64");
    return { authorization: `Basic ${basic}` };
  }

  return {
    discover,

    async getAuthorizationUrl(input) {
      const d = await discover();
      const url = new URL(d.authorization_endpoint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", input.scope ?? "openid email");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      // Только S256. plain не даёт защиты, ради которой PKCE существует,
      // и сервис его не примет.
      url.searchParams.set("code_challenge_method", "S256");
      if (input.prompt) url.searchParams.set("prompt", input.prompt);
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const d = await discover();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: options.clientId,
      });
      const res = await doFetch(d.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...authHeader(),
        },
        body,
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new SimpasError(`обмен кода не удался: ${detail}`, "token_exchange_failed", res.status);
      }
      return (await res.json()) as TokenSet;
    },

    async verifyIdToken(token, expected) {
      const d = await discover();
      jwks ??= createRemoteJWKSet(new URL(d.jwks_uri));
      // Подпись проверяется библиотекой, а не руками. alg берётся из
      // метаданных, но none не примет ни jose, ни сервис.
      const { payload } = await jwtVerify(token, jwks, {
        issuer: d.issuer,
        audience: options.clientId,
      });
      if (expected?.nonce && payload.nonce !== expected.nonce) {
        throw new SimpasError("nonce не совпадает", "nonce_mismatch");
      }
      return payload as IdTokenClaims;
    },

    async getAccount(accessToken) {
      const res = await doFetch(`${issuer}/v1/account`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
      if (!res.ok) {
        throw new SimpasError("профиль недоступен", "account_failed", res.status);
      }
      return (await res.json()) as SimpasAccount;
    },

    async refresh(refreshToken) {
      const d = await discover();
      const res = await doFetch(d.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...authHeader(),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: options.clientId,
        }),
      });
      if (!res.ok) {
        throw new SimpasError("обновление не удалось", "refresh_failed", res.status);
      }
      return (await res.json()) as TokenSet;
    },
  };
}
