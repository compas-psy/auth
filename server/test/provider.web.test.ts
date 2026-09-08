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

/**
 * Начало взаимодействия. Cookie отдаются РАЗОБРАННЫМИ, с путями: иначе
 * проверка снова начнёт слать их куда угодно и снова окажется зелёной
 * там, где живой браузер молчит.
 */
async function startInteraction(): Promise<{
  uid: string; jar: ReturnType<typeof jarFrom>;
}> {
  const r = await app.inject({ url: AUTH, headers: HOST });
  const uid = String(r.headers.location).replace("/interaction/", "");
  return { uid, jar: jarFrom(r.headers["set-cookie"]) };
}

describe("начало входа через провайдера", () => {
  it("без подключённого провайдера кнопка никуда не ведёт: 404", async () => {
    const { uid, jar } = await startInteraction();
    const to = `/interaction/${uid}/provider/yandex`;
    const r = await app.inject({ url: to, headers: { ...HOST, cookie: cookiesFor(jar, to) } });
    expect(r.statusCode).toBe(404);
  });

  it("с подключённым — уводит к провайдеру и заводит одноразовый state", async () => {
    fakeYandex({ subject: "y-1", email: "y1@ya.ru" });
    const { uid, jar } = await startInteraction();
    const to = `/interaction/${uid}/provider/yandex`;
    const r = await app.inject({ url: to, headers: { ...HOST, cookie: cookiesFor(jar, to) } });
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

/**
 * Cookie-банка, ведущая себя как браузер: она уважает Path.
 *
 * Прежние проверки брали `c.split(";")[0]` — то есть ОТБРАСЫВАЛИ Path и
 * слали cookie куда угодно. Обработчик возврата от провайдера от этого
 * был зелёным, а в живом браузере вход через Яндекс падал: cookie
 * взаимодействия выдаётся с path=/interaction/<uid> (проверено
 * заголовком Set-Cookie), а Яндекс возвращает человека на /callback/
 * yandex — постоянный адрес, в который uid не вставить. На этот путь
 * браузер cookie не отправляет, и взаимодействие не находится.
 *
 * Тест, не уважающий Path, доказывает лишь то, что обработчик сработает,
 * ЕСЛИ cookie придёт. Про то, придёт ли она, он не говорит ничего.
 */
function jarFrom(raw: string | string[] | undefined): Array<{
  name: string; value: string; path: string;
}> {
  const list = Array.isArray(raw) ? raw : [String(raw ?? "")];
  return list.filter(Boolean).map((c) => {
    const [pair, ...attrs] = c.split(";");
    const [name, ...rest] = pair!.split("=");
    const path = attrs
      .map((a) => a.trim())
      .find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
    return { name: name!.trim(), value: rest.join("="), path };
  });
}

/** Отбирает то, что браузер отправил бы на этот путь. */
function cookiesFor(jar: ReturnType<typeof jarFrom>, url: string): string {
  const path = url.split("?")[0]!;
  return jar
    .filter((c) => path === c.path || path.startsWith(c.path.replace(/\/$/, "") + "/"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

describe("возврат от провайдера приходит на постоянный адрес", () => {
  it("браузер доносит взаимодействие до /callback, а не теряет его", async () => {
    fakeYandex({ subject: "y-path", email: "path@ya.ru" });
    const started = await app.inject({ url: AUTH, headers: HOST });
    const uid = String(started.headers.location).replace("/interaction/", "");
    const jar = jarFrom(started.headers["set-cookie"]);

    const toProvider = `/interaction/${uid}/provider/yandex`;
    const r = await app.inject({
      url: toProvider, headers: { ...HOST, cookie: cookiesFor(jar, toProvider) } });
    const state = new URL(String(r.headers.location)).searchParams.get("state")!;

    // Адрес возврата ПОСТОЯННЫЙ: он зарегистрирован у провайдера, и uid
    // в него не вставить. Именно поэтому суженный по пути cookie сюда
    // не доезжает.
    const back = `/callback/yandex?code=c&state=${state}`;
    const sent = cookiesFor(jar, back);
    expect(sent, "браузер не отправит взаимодействие на /callback").not.toBe("");

    const done = await app.inject({ url: back, headers: { ...HOST, cookie: sent } });
    expect(done.statusCode).toBe(303);
    expect(String(done.headers.location)).toContain("/oidc/auth/");
  });
});

describe("возврат от провайдера", () => {
  async function begin(identity: Parameters<typeof fakeYandex>[0]) {
    fakeYandex(identity);
    const { uid, jar } = await startInteraction();
    const to = `/interaction/${uid}/provider/yandex`;
    const r = await app.inject({ url: to, headers: { ...HOST, cookie: cookiesFor(jar, to) } });
    const state = new URL(String(r.headers.location)).searchParams.get("state")!;
    return { uid, jar, state };
  }

  it("первый вход заводит запись, привязку и доводит до продукта", async () => {
    const { jar, state } = await begin({ subject: "y-new", email: "new@ya.ru" });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`,
      headers: { ...HOST, cookie: cookiesFor(jar, `/callback/yandex`) } });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers.location)).toContain("/oidc/auth/");

    const { rows } = await getPool().query("SELECT provider, subject FROM identities");
    expect(rows[0]).toMatchObject({ provider: "yandex", subject: "y-new" });
  });

  it("state одноразовый: повтор того же возврата не пускает", async () => {
    const { jar, state } = await begin({ subject: "y-once", email: "once@ya.ru" });
    const url = `/callback/yandex?code=c&state=${state}`;
    const jarHeader = cookiesFor(jar, "/callback/yandex");
    expect((await app.inject({ url, headers: { ...HOST, cookie: jarHeader } })).statusCode).toBe(303);
    expect((await app.inject({ url, headers: { ...HOST, cookie: jarHeader } })).statusCode).toBe(400);
  });

  it("подделанный state не пускает", async () => {
    await begin({ subject: "y-x", email: "x@ya.ru" });
    const r = await app.inject({
      url: "/callback/yandex?code=c&state=не-тот", headers: HOST });
    expect(r.statusCode).toBe(400);
  });

  it("провайдер без подтверждённой почты ведёт на экран «Нужна почта»", async () => {
    const { jar, state } = await begin({ subject: "y-noemail", email: null });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`,
      headers: { ...HOST, cookie: cookiesFor(jar, `/callback/yandex`) } });
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
    const { jar, state } = await begin({ subject: "taken", email: "stranger@ya.ru" });
    const r = await app.inject({
      url: `/callback/yandex?code=c&state=${state}`,
      headers: { ...HOST, cookie: cookiesFor(jar, `/callback/yandex`) } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain("уже привязан");
  });

  it("отказ провайдера показывает человеческий текст, а не стек", async () => {
    fakeYandex({ subject: "y", email: "y@ya.ru" });
    const { uid, jar } = await startInteraction();
    const r = await app.inject({
      url: `/callback/yandex?error=access_denied&state=x`,
      headers: { ...HOST, cookie: cookiesFor(jar, "/callback/yandex") } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("access_denied");
    void uid;
  });

  it("почта провайдера в журнал не пишется", async () => {
    const { jar, state } = await begin({ subject: "y-log", email: "secret@ya.ru" });
    await app.inject({
      url: `/callback/yandex?code=c&state=${state}`,
      headers: { ...HOST, cookie: cookiesFor(jar, `/callback/yandex`) } });
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
