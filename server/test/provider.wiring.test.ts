import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { clearWebProviders } from "../src/services/providers/registry.js";

/**
 * Сквозная проверка: ключи в окружении → реестр → API → экран → уход
 * к провайдеру.
 *
 * Ни один модульный тест этой цепочки целиком не покрывает, а рвётся
 * она молча: провайдер просто не появляется на экране, и понять,
 * на каком звене, без разбора невозможно.
 */
let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const AUTH = "/oidc/auth?" + new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  clearWebProviders();
  // Ровно то, что выкладка запишет в .env на сервере.
  process.env.YANDEX_CLIENT_ID = "wiring-id";
  process.env.YANDEX_CLIENT_SECRET = "wiring-secret";
  const { buildServer } = await import("../src/index.js");
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  delete process.env.YANDEX_CLIENT_ID;
  delete process.env.YANDEX_CLIENT_SECRET;
  clearWebProviders();
  await app.close();
  await closePool();
});

async function interaction(): Promise<{ uid: string; cookies: string }> {
  const r = await app.inject({ url: AUTH, headers: HOST });
  const raw = r.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw ?? "")];
  return {
    uid: String(r.headers.location).replace("/interaction/", ""),
    cookies: list.map((c) => c.split(";")[0]).join("; "),
  };
}

describe("ключи Яндекса из окружения доходят до экрана", () => {
  it("API называет Яндекс среди способов входа в вебе", async () => {
    const r = await app.inject({
      url: "/v1/auth/methods?platform=web", headers: { "x-client-id": "practice-mobile" } });
    expect(r.json().providers).toEqual(["yandex"]);
  });

  it("на мобильном его по-прежнему нет: там нужен SDK, а не ключи", async () => {
    const r = await app.inject({
      url: "/v1/auth/methods?platform=android", headers: { "x-client-id": "practice-mobile" } });
    expect(r.json().providers).toEqual([]);
  });

  it("экран входа получает провайдера в состоянии", async () => {
    const { uid, cookies } = await interaction();
    const r = await app.inject({
      url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    const json = /<script id="state" type="application\/json">(.*?)<\/script>/s.exec(r.body)![1]!;
    expect(JSON.parse(json.replace(/\\u003c/g, "<")).providers).toEqual(["yandex"]);
  });

  it("кнопка уводит на Яндекс с ТЕМ ЖЕ redirect_uri, что зарегистрирован", async () => {
    // Несовпадение здесь — самая частая причина отказа при входе, и
    // она видна только человеку, который уже нажал кнопку.
    const { uid, cookies } = await interaction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(303);

    const url = new URL(String(r.headers.location));
    expect(url.origin + url.pathname).toBe("https://oauth.yandex.ru/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://auth.cmpas.ru/callback/yandex");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("wiring-id");
  });

  it("запрашиваются только почта и идентификатор", async () => {
    const { uid, cookies } = await interaction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    const scope = new URL(String(r.headers.location)).searchParams.get("scope");
    expect(scope).toBe("login:email login:info");
    // Аватар, телефон и день рождения не запрашиваются: человек видит
    // перечень прав на экране согласия Яндекса, и лишнее там — это
    // обещание, которое мы сами же нарушаем.
    for (const forbidden of ["avatar", "phone", "birthday"]) {
      expect({ forbidden, asked: String(scope).includes(forbidden) })
        .toEqual({ forbidden, asked: false });
    }
  });

  it("секрет не уходит в адресную строку человека", async () => {
    const { uid, cookies } = await interaction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    expect(String(r.headers.location)).not.toContain("wiring-secret");
  });

  it("каждый уход к провайдеру несёт свой одноразовый state", async () => {
    const a = await interaction();
    const b = await interaction();
    const stateOf = async (i: { uid: string; cookies: string }) => {
      const r = await app.inject({
        url: `/interaction/${i.uid}/provider/yandex`, headers: { ...HOST, cookie: i.cookies } });
      return new URL(String(r.headers.location)).searchParams.get("state")!;
    };
    const first = await stateOf(a);
    const second = await stateOf(b);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
  });
});
