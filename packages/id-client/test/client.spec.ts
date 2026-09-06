import { describe, it, expect, vi } from "vitest";
import { createSimpasClient, createPkcePair, createState, SimpasError } from "../src/index.js";

const ISSUER = "https://auth.cmpas.ru";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oidc/auth`,
  token_endpoint: `${ISSUER}/oidc/token`,
  jwks_uri: `${ISSUER}/oidc/jwks`,
};

function fakeFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const base = { issuer: ISSUER, clientId: "practice", clientSecret: "s".repeat(32) };

describe("PKCE", () => {
  it("проверочный код и его отпечаток разные и устойчивые по форме", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeVerifier).not.toBe(codeChallenge);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("каждый вызов даёт новую пару", () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
  });

  it("state одноразовый", () => {
    expect(createState()).not.toBe(createState());
  });
});

describe("адрес авторизации", () => {
  it("собирается из метаданных и всегда несёт PKCE S256", async () => {
    const client = createSimpasClient({ ...base, fetchImpl: fakeFetch({ "openid-configuration": DISCOVERY }) });
    const url = new URL(await client.getAuthorizationUrl({
      redirectUri: "https://cmpas.ru/api/auth/callback/simpasid",
      state: "st", nonce: "nc", codeChallenge: "ch",
    }));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oidc/auth`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("nonce")).toBe("nc");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("никогда не собирает адрес с методом plain", async () => {
    const client = createSimpasClient({ ...base, fetchImpl: fakeFetch({ "openid-configuration": DISCOVERY }) });
    const url = await client.getAuthorizationUrl({
      redirectUri: "https://cmpas.ru/cb", state: "s", nonce: "n", codeChallenge: "c" });
    expect(url).not.toContain("plain");
  });

  it("метаданные с чужим issuer отвергаются", async () => {
    const client = createSimpasClient({
      ...base,
      fetchImpl: fakeFetch({ "openid-configuration": { ...DISCOVERY, issuer: "https://evil.test" } }),
    });
    await expect(client.discover()).rejects.toThrow(SimpasError);
  });

  it("метаданные читаются один раз и запоминаются", async () => {
    const f = fakeFetch({ "openid-configuration": DISCOVERY });
    const client = createSimpasClient({ ...base, fetchImpl: f });
    await client.discover();
    await client.discover();
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});

describe("обмен кода", () => {
  it("отправляет code_verifier и не отправляет секрет в теле", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = String(url).includes("openid-configuration")
        ? DISCOVERY
        : { access_token: "at", id_token: "it", token_type: "Bearer", expires_in: 900 };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createSimpasClient({ ...base, fetchImpl: f });
    const tokens = await client.exchangeCode({
      code: "c", codeVerifier: "v", redirectUri: "https://cmpas.ru/cb" });
    expect(tokens.access_token).toBe("at");

    const tokenCall = calls.find((c) => c.url.includes("/token"))!;
    const body = String(tokenCall.init?.body);
    expect(body).toContain("code_verifier=v");
    // Секрет уходит заголовком Basic, а не в теле запроса.
    expect(body).not.toContain("client_secret");
    expect(String((tokenCall.init?.headers as Record<string, string>).authorization))
      .toMatch(/^Basic /);
  });

  it("отказ обмена не проглатывается", async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("openid-configuration")
        ? new Response(JSON.stringify(DISCOVERY), { status: 200 })
        : new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    const client = createSimpasClient({ ...base, fetchImpl: f });
    await expect(client.exchangeCode({
      code: "c", codeVerifier: "v", redirectUri: "https://cmpas.ru/cb" }))
      .rejects.toThrow(SimpasError);
  });

  it("публичный клиент обходится без секрета", async () => {
    const calls: RequestInit[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init) calls.push(init);
      return new Response(JSON.stringify(
        String(url).includes("openid-configuration") ? DISCOVERY
          : { access_token: "at", id_token: "it", token_type: "Bearer", expires_in: 900 },
      ), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createSimpasClient({ issuer: ISSUER, clientId: "mobile", fetchImpl: f });
    await client.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "app://cb" });
    for (const c of calls) {
      expect((c.headers as Record<string, string>).authorization).toBeUndefined();
    }
  });
});

describe("профиль", () => {
  it("берётся тем же публичным API, что и у портала", async () => {
    const f = fakeFetch({
      "openid-configuration": DISCOVERY,
      "/v1/account": { id: "acc_1", email: "t@ya.ru", email_verified: true,
        display_name: null, products: ["practice"] },
    });
    const client = createSimpasClient({ ...base, fetchImpl: f });
    const account = await client.getAccount("at");
    expect(account.email).toBe("t@ya.ru");
    expect(account.products).toEqual(["practice"]);
  });

  it("недоступный профиль даёт понятный отказ, а не пустой объект", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = createSimpasClient({ ...base, fetchImpl: f });
    await expect(client.getAccount("bad")).rejects.toThrow(SimpasError);
  });
});
