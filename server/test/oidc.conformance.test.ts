import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { ensureSchema, ensureTestClient } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  await ensureSchema();
  await ensureTestClient();
  app = await buildServer();
  await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

const CB = encodeURIComponent("https://ex.test/cb");

// Заголовки боевого контура: за прокси приходят Host и X-Forwarded-Proto,
// и провайдер по ним строит абсолютные адреса и решает, ставить ли Secure.
// Без них inject ходит по http://localhost, и запрос отвергается как
// небезопасный ещё до проверки параметров — то есть тест проверял бы
// не то, что происходит в бою.
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const authUrl = (params: Record<string, string>): string =>
  "/oidc/auth?" + new URLSearchParams(params).toString();

const VALID = {
  client_id: "test",
  response_type: "code",
  redirect_uri: "https://ex.test/cb",
  scope: "openid email",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "st",
  nonce: "nc",
};

/**
 * Ошибка протокола при ДЕЙСТВИТЕЛЬНОМ redirect_uri возвращается на него
 * же — так требует OAuth 2.0 §4.1.2.1, и библиотека отвечает 303.
 * План ждал [400, 302]; верно поведение библиотеки, расхождение
 * зафиксировано в отчёте Задачи 6.
 */
function expectProtocolError(
  r: { statusCode: number; headers: Record<string, unknown>; body: string },
  code: string,
): void {
  expect([303, 302, 400]).toContain(r.statusCode);
  const where = String(r.headers.location ?? "") + r.body;
  expect(where).toContain(code);
}

describe("Т7: конформность протокола", () => {
  it("discovery отвечает и объявляет только code", async () => {
    const r = await app.inject({ url: "/oidc/.well-known/openid-configuration" });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.response_types_supported).toEqual(["code"]);
    expect(d.code_challenge_methods_supported).toContain("S256");
    expect(d.id_token_signing_alg_values_supported).not.toContain("none");
  });

  it("issuer в discovery — ровно тот, что в CLAUDE.md", async () => {
    const d = (await app.inject({ url: "/oidc/.well-known/openid-configuration" })).json();
    expect(d.issuer).toBe("https://auth.cmpas.ru");
  });

  it("discovery доступен и по адресу, который выводится из issuer", async () => {
    // Клиент с issuer=https://auth.cmpas.ru идёт за метаданными на
    // /.well-known/openid-configuration. Без этого рецепт для ПРАКТИКИ
    // (next-auth выводит wellKnown из issuer) не работает.
    const r = await app.inject({ url: "/.well-known/openid-configuration" });
    expect(r.statusCode).toBe(200);
    expect(r.json().issuer).toBe("https://auth.cmpas.ru");
  });

  it("объявленные адреса ручек ведут на смонтированный префикс", async () => {
    const d = (await app.inject({
      url: "/oidc/.well-known/openid-configuration", headers: HOST,
    })).json();
    expect(d.authorization_endpoint).toBe("https://auth.cmpas.ru/oidc/auth");
    expect(d.token_endpoint).toBe("https://auth.cmpas.ru/oidc/token");
    expect(d.jwks_uri).toBe("https://auth.cmpas.ru/oidc/jwks");
  });

  it("JWKS отдаёт ключи и не отдаёт приватную часть", async () => {
    const r = await app.inject({ url: "/oidc/jwks" });
    expect(r.statusCode).toBe(200);
    const keys = r.json().keys;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.d).toBeUndefined();
      expect(k.p).toBeUndefined();
      expect(k.q).toBeUndefined();
      expect(k.kid).toBeTruthy();
    }
  });

  it("запрос без code_challenge отклоняется", async () => {
    const { code_challenge, code_challenge_method, ...noPkce } = VALID;
    void code_challenge; void code_challenge_method;
    const r = await app.inject({ url: authUrl(noPkce), headers: HOST });
    expectProtocolError(r, "invalid_request");
  });

  it("code_challenge_method=plain отклоняется: разрешён только S256", async () => {
    const r = await app.inject({
      url: authUrl({ ...VALID, code_challenge_method: "plain" }), headers: HOST,
    });
    expectProtocolError(r, "invalid_request");
  });

  it("redirect_uri вне белого списка отклоняется", async () => {
    // Сюда редиректить нельзя: адрес не наш. Ответ — 400 на месте.
    const r = await app.inject({
      url: authUrl({ ...VALID, redirect_uri: "https://evil.test/cb" }), headers: HOST,
    });
    expect(r.statusCode).toBe(400);
  });

  it("redirect_uri совпадает точно, без префиксов и шаблонов", async () => {
    const r = await app.inject({
      url: authUrl({ ...VALID, redirect_uri: "https://ex.test/cb/extra" }), headers: HOST,
    });
    expect(r.statusCode).toBe(400);
  });

  it("response_type=token (implicit) не поддерживается", async () => {
    const r = await app.inject({
      url: authUrl({ ...VALID, response_type: "token" }), headers: HOST,
    });
    expectProtocolError(r, "unsupported_response_type");
  });

  it("password grant отсутствует: паролей нет и быть не может", async () => {
    const d = (await app.inject({
      url: "/oidc/.well-known/openid-configuration", headers: HOST,
    })).json();
    expect(d.grant_types_supported).not.toContain("password");
    expect(d.grant_types_supported).not.toContain("implicit");
    expect(d.grant_types_supported).toContain("authorization_code");
  });

  it("правильный запрос доводится до экрана входа, а не до ошибки", async () => {
    const r = await app.inject({ url: authUrl(VALID), headers: HOST });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toMatch(/^\/interaction\//);
  });
});

describe("Р-2: cookie не поднимается на общий домен", () => {
  it("ни одна cookie не задаёт атрибут Domain", async () => {
    const r = await app.inject({ url: authUrl(VALID), headers: HOST });
    const set = String(r.headers["set-cookie"] ?? "");
    expect(set).not.toMatch(/Domain=/i);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Secure/i);
  });
});
