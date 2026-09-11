import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createClient } from "../src/oidc/clients.js";
import { PORTAL_CLIENT, PORTAL_REDIRECT } from "../src/oidc/portalClient.js";

/**
 * Портал аккаунта НАСКВОЗЬ: от пустого браузера до собственных данных.
 *
 * До этой правки портал ходил в /v1 только с cookie, а API принимает
 * только Bearer. Значит он не открывался НИ РАЗУ И НИ У КОГО:
 * getAccount() падал с 401, обещание никто не ловил, и на экране
 * навсегда оставался пустой div. Учредитель увидел это, набрав
 * auth.cmpas.ru руками, но то же самое получил бы любой, кто пришёл по
 * ссылке «Аккаунт СИМПАС» из продукта.
 *
 * Ни один тест этого не ловил: каждое звено проверялось по отдельности,
 * а связку «портал → API» не проверял никто.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

class Jar {
  private readonly jar = new Map<string, string>();
  take(r: { headers: Record<string, unknown> }): void {
    const raw = r.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
    for (const line of list) {
      const pair = String(line).split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
      if (value === "") this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  get header(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
}

beforeAll(async () => {
  await resetData();
  await createClient({
    clientId: PORTAL_CLIENT, clientName: "Аккаунт СИМПАС",
    redirectUris: [PORTAL_REDIRECT], product: null, isPublic: true,
  });
  app = await buildServer(); await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

describe("портал аккаунта наскозь", () => {
  it("человек с пустым браузером доходит до своих данных", async () => {
    const params = new URLSearchParams({
      client_id: PORTAL_CLIENT, response_type: "code", redirect_uri: PORTAL_REDIRECT,
      scope: "openid email", code_challenge: CHALLENGE,
      code_challenge_method: "S256", state: "st-p", nonce: "nc-p",
    });
    const jar = new Jar();
    const auth = await app.inject({ url: `/oidc/auth?${params}`, headers: HOST });
    expect(auth.statusCode, auth.body).toBe(303);
    const uid = String(auth.headers.location).replace("/interaction/", "");
    jar.take(auth);

    const { issueMagicLink } = await import("../src/services/magicLink.js");
    const issued = await issueMagicLink({
      email: "portal@ya.ru", deviceKey: uid, platform: "web", termsVersion: "0.9" });
    if ("throttled" in issued) throw new Error("не ожидали паузы");

    const back = await app.inject({
      url: `/interaction/${uid}/callback?token=${issued.token}`,
      headers: { ...HOST, cookie: jar.header },
    });
    jar.take(back);

    let location = String(back.headers.location);
    let redirect: string | undefined;
    for (let hop = 0; hop < 6 && !redirect; hop += 1) {
      const step = await app.inject({ url: location, headers: { ...HOST, cookie: jar.header } });
      jar.take(step);
      location = String(step.headers.location ?? "");
      if (location.startsWith(PORTAL_REDIRECT)) redirect = location;
    }
    expect(redirect, "провайдер не вернул портал на его адрес").toBeDefined();
    const code = new URL(redirect!).searchParams.get("code");
    expect(code).toBeTruthy();

    // Публичный клиент: секрета нет и в обмене он не участвует.
    //
    // ORIGIN ОБЯЗАТЕЛЕН В ПРОВЕРКЕ. Браузер шлёт его на КАЖДЫЙ POST, в
    // том числе на собственный домен. Без него проверка доказывала
    // механизм обмена, но не то, что обмен пройдёт из браузера, — и
    // пропустила отказ, который живой человек получал на боевом:
    // {"error":"invalid_request","error_description":
    //  "origin https://auth.cmpas.ru not allowed for client: account-portal"}
    const tokens = await app.inject({
      method: "POST", url: "/oidc/token",
      headers: {
        ...HOST, "content-type": "application/x-www-form-urlencoded",
        origin: "https://auth.cmpas.ru",
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: code!,
        redirect_uri: PORTAL_REDIRECT, client_id: PORTAL_CLIENT,
        code_verifier: VERIFIER,
      }).toString(),
    });
    expect(tokens.statusCode, tokens.body).toBe(200);
    const access = (tokens.json() as { access_token?: string }).access_token;
    expect(access, "ключ доступа не выдан").toBeTruthy();

    // ВОТ ЭТОГО и не было: портал доходит до собственных данных.
    const profile = await app.inject({
      url: "/v1/account", headers: { ...HOST, authorization: `Bearer ${access}` } });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json()).toMatchObject({ email: "portal@ya.ru", email_verified: true });
  });

  it("без ключа доступа API отвечает отказом, а не пустотой", async () => {
    // Именно этот отказ портал прежде получал молча.
    const r = await app.inject({
      url: "/v1/account", headers: { ...HOST, cookie: "__Host-simpas_session=что-угодно" } });
    expect(r.statusCode).toBe(401);
  });

  it("обмен без проверочного кода PKCE не проходит", async () => {
    // У публичного клиента PKCE — единственная защита кода.
    const r = await app.inject({
      method: "POST", url: "/oidc/token",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: "чужой",
        redirect_uri: PORTAL_REDIRECT, client_id: PORTAL_CLIENT,
      }).toString(),
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/**
 * Разрешение по Origin — ровно наш домен и ничей больше.
 *
 * Умолчание библиотеки отвергало всех, включая наш портал, и он не мог
 * войти. Соблазн «разрешить всё» здесь стоил бы дорого: чужая страница
 * получила бы возможность обменивать коды из браузера человека.
 */
describe("кто может обращаться к обмену из браузера", () => {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: "чужой",
    redirect_uri: PORTAL_REDIRECT, client_id: PORTAL_CLIENT,
    code_verifier: VERIFIER,
  }).toString();

  async function exchangeFrom(origin: string | undefined) {
    return app.inject({
      method: "POST", url: "/oidc/token",
      headers: {
        ...HOST, "content-type": "application/x-www-form-urlencoded",
        ...(origin ? { origin } : {}),
      },
      payload: body,
    });
  }

  it("свой домен допущен: отказ приходит про код, а не про домен", async () => {
    const r = await exchangeFrom("https://auth.cmpas.ru");
    expect(r.body).not.toContain("not allowed for client");
    expect(r.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("чужой домен не допущен", async () => {
    const r = await exchangeFrom("https://evil.test");
    expect(r.json()).toMatchObject({ error: "invalid_request" });
    expect(r.body).toContain("not allowed for client");
  });

  it("похожий домен не считается своим", async () => {
    // auth.cmpas.ru.evil.test и auth.cmpas.ru — разные домены.
    const r = await exchangeFrom("https://auth.cmpas.ru.evil.test");
    expect(r.body).toContain("not allowed for client");
  });

  it("запрос без браузера — без Origin — проходит как прежде", async () => {
    // Продукты меняют код на СЕРВЕРЕ: заголовка Origin у них нет.
    const r = await exchangeFrom(undefined);
    expect(r.body).not.toContain("not allowed for client");
  });
});

describe("знак СИМПАС отдаётся продуктам", () => {
  /**
   * Четыре продукта получают знак из одного места — иначе каждый
   * нарисует свой. Адрес назван в docs/integration/checklist.md, и
   * документ, обещающий адрес, который отвечает 404, хуже молчания:
   * ровно так мы уже потеряли день на /return/:product.
   */
  it("канонический знак открывается по адресу из рецепта", async () => {
    const r = await app.inject({ url: "/assets/brand/simpas-logo-disc.svg" });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["content-type"])).toContain("svg");
    expect(r.body).toContain("<svg");
  });
});
