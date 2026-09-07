import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { registerWebProvider, clearWebProviders } from "../src/services/providers/registry.js";
import type { YandexAdapter } from "../src/services/providers/yandex.js";

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const AUTH = "/oidc/auth?" + new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

function fakeYandex(identity: { subject: string; email: string | null; emailVerified?: boolean }) {
  const adapter: YandexAdapter = {
    provider: "yandex",
    authorizationUrl: (state) => `https://oauth.yandex.ru/authorize?state=${state}`,
    exchange: vi.fn(async () => ({
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified ?? identity.email !== null,
    })),
  };
  registerWebProvider(adapter);
  return adapter;
}

beforeEach(async () => {
  await resetData();
  await ensureTestClient();
  clearWebProviders();
  if (!app) { app = await buildServer(); await app.ready(); }
});
afterAll(async () => { clearWebProviders(); if (app) await app.close(); await closePool(); });

async function startInteraction(): Promise<{ uid: string; cookies: string }> {
  const r = await app.inject({ url: AUTH, headers: HOST });
  const uid = String(r.headers.location).replace("/interaction/", "");
  const raw = r.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw ?? "")];
  return { uid, cookies: list.map((c) => c.split(";")[0]).join("; ") };
}

describe("начало входа через провайдера", () => {
  it("без подключённого провайдера кнопка никуда не ведёт: 404", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(404);
  });

  it("с подключённым — уводит к провайдеру и заводит одноразовый state", async () => {
    fakeYandex({ subject: "y-1", email: "y1@ya.ru" });
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers.location)).toContain("oauth.yandex.ru");

    const { rows } = await getPool().query("SELECT * FROM provider_login_states");
    expect(rows).toHaveLength(1);
    // Сырой state в базе не хранится — только хеш, как и все
    // одноразовые секреты в этом сервисе.
    const raw = new URL(String(r.headers.location)).searchParams.get("state")!;
    expect(JSON.stringify(rows)).not.toContain(raw);
  });
});

describe("возврат от провайдера", () => {
  async function begin(identity: Parameters<typeof fakeYandex>[0]) {
    fakeYandex(identity);
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie: cookies } });
    const state = new URL(String(r.headers.location)).searchParams.get("state")!;
    return { uid, cookies, state };
  }

  it("первый вход заводит запись, привязку и доводит до продукта", async () => {
    const { cookies, state } = await begin({ subject: "y-new", email: "new@ya.ru" });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers.location)).toContain("/oidc/auth/");

    const { rows } = await getPool().query("SELECT provider, subject FROM identities");
    expect(rows[0]).toMatchObject({ provider: "yandex", subject: "y-new" });
  });

  it("state одноразовый: повтор того же возврата не пускает", async () => {
    const { cookies, state } = await begin({ subject: "y-once", email: "once@ya.ru" });
    const url = `/callback/yandex?code=c&state=${state}`;
    expect((await app.inject({ url, headers: { ...HOST, cookie: cookies } })).statusCode).toBe(303);
    expect((await app.inject({ url, headers: { ...HOST, cookie: cookies } })).statusCode).toBe(400);
  });

  it("подделанный state не пускает", async () => {
    await begin({ subject: "y-x", email: "x@ya.ru" });
    const r = await app.inject({
      url: "/callback/yandex?code=c&state=не-тот", headers: HOST });
    expect(r.statusCode).toBe(400);
  });

  it("провайдер без подтверждённой почты ведёт на экран «Нужна почта»", async () => {
    const { cookies, state } = await begin({ subject: "y-noemail", email: null });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Нужна электронная почта");
    // Учётная запись при этом НЕ заводится: И-5 не выполнен.
    const { rows } = await getPool().query("SELECT count(*)::int n FROM accounts");
    expect(rows[0].n).toBe(0);
  });

  it("занятый аккаунт провайдера показывает экран C3, а не пускает", async () => {
    const other = await createAccountWithEmail("owner@ya.ru");
    await getPool().query(
      `INSERT INTO identities (account_id, provider, subject) VALUES ($1,'yandex','taken')`,
      [other.accountId]);
    const { cookies, state } = await begin({ subject: "taken", email: "stranger@ya.ru" });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain("уже привязан");
  });

  it("отказ провайдера показывает человеческий текст, а не стек", async () => {
    fakeYandex({ subject: "y", email: "y@ya.ru" });
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      url: `/callback/yandex?error=access_denied&state=x`,
      headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("access_denied");
    void uid;
  });

  it("почта провайдера в журнал не пишется", async () => {
    const { cookies, state } = await begin({ subject: "y-log", email: "secret@ya.ru" });
    await app.inject({
      url: `/callback/yandex?code=c&state=${state}`, headers: { ...HOST, cookie: cookies } });
    const { rows } = await getPool().query("SELECT * FROM audit_log");
    expect(JSON.stringify(rows)).not.toContain("secret@ya.ru");
  });
});

describe("состав способов входа", () => {
  it("подключённый провайдер появляется в вебе", async () => {
    fakeYandex({ subject: "y", email: "y@ya.ru" });
    const r = await app.inject({
      url: "/v1/auth/methods?platform=web", headers: { "x-client-id": "practice-mobile" } });
    expect(r.json().providers).toEqual(["yandex"]);
  });

  it("на мобильном его нет: там нужен проверенный SDK, а не веб-редирект", async () => {
    fakeYandex({ subject: "y", email: "y@ya.ru" });
    const r = await app.inject({
      url: "/v1/auth/methods?platform=android", headers: { "x-client-id": "practice-mobile" } });
    expect(r.json().providers).toEqual([]);
  });
});
