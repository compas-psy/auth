import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const VALID = new URLSearchParams({
  client_id: "test",
  response_type: "code",
  redirect_uri: "https://ex.test/cb",
  scope: "openid email",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "st",
  nonce: "nc",
});

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => { await resetData(); await ensureTestClient(); });
afterAll(async () => { await app.close(); await closePool(); });

async function startInteraction(): Promise<{ uid: string; cookies: string }> {
  const r = await app.inject({ url: `/oidc/auth?${VALID}`, headers: HOST });
  const uid = String(r.headers.location).replace("/interaction/", "");
  const raw = r.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw ?? "")];
  return { uid, cookies: list.map((c) => c.split(";")[0]).join("; ") };
}

describe("экраны взаимодействия", () => {
  it("экран входа отдаётся по адресу, который назвал провайдер", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("на экране входа нет обязательного чекбокса", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    expect(r.body).not.toMatch(/type=["']checkbox["']/);
  });

  it("юридическая строка называет редакцию и не принимает Политику", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    expect(r.body).toContain("редакция 0.9");
    expect(r.body).toContain("Политике обработки персональных данных");
    expect(r.body).not.toMatch(/принима\w+ Политик/i);
  });

  it("состав способов входа приходит с сервера вместе с экраном", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    expect(r.body).toContain('"providers"');
  });

  it("страницы взаимодействия не кэшируются", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
    expect(String(r.headers["cache-control"])).toContain("no-store");
  });

  it("чужой uid не открывает чужое взаимодействие", async () => {
    const r = await app.inject({
      url: "/interaction/00000000000000000000", headers: HOST });
    expect([400, 404]).toContain(r.statusCode);
  });

  it("отправка почты выпускает ссылку и ведёт на «Проверьте почту»", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      method: "POST", url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie: cookies },
      payload: { email: "flow@ya.ru" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("sent");
    const { rows } = await getPool().query("SELECT count(*)::int n FROM magic_link_tokens");
    expect(rows[0].n).toBe(1);
  });

  it("повтор чаще паузы отвечает так же, но письма не шлёт", async () => {
    const { uid, cookies } = await startInteraction();
    const body = { method: "POST" as const, url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie: cookies }, payload: { email: "throttle@ya.ru" } };
    await app.inject(body);
    const second = await app.inject(body);
    expect(second.statusCode).toBe(200);
    const { rows } = await getPool().query("SELECT count(*)::int n FROM magic_link_tokens");
    expect(rows[0].n).toBe(1);
  });

  it("ответ на почту не раскрывает, есть ли такой аккаунт", async () => {
    const a = await startInteraction();
    const known = await app.inject({ method: "POST", url: `/interaction/${a.uid}/email`,
      headers: { ...HOST, cookie: a.cookies }, payload: { email: "k@ya.ru" } });
    const b = await startInteraction();
    const unknown = await app.inject({ method: "POST", url: `/interaction/${b.uid}/email`,
      headers: { ...HOST, cookie: b.cookies }, payload: { email: "u@ya.ru" } });
    expect(known.json()).toEqual(unknown.json());
  });

  it("переход по ссылке из письма доводит вход до конца", async () => {
    const { uid, cookies } = await startInteraction();
    await app.inject({ method: "POST", url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie: cookies }, payload: { email: "done@ya.ru" } });
    const { rows } = await getPool().query<{ token_hash: string }>(
      "SELECT token_hash FROM magic_link_tokens");
    expect(rows).toHaveLength(1);

    // Токен известен только владельцу почты; в тесте берём его так же,
    // как это делает человек, — из выпуска.
    const { issueMagicLink } = await import("../src/services/magicLink.js");
    await getPool().query("DELETE FROM magic_link_tokens");
    const issued = await issueMagicLink({
      email: "done@ya.ru", deviceKey: uid, platform: "web", termsVersion: "0.9" });
    if ("throttled" in issued) throw new Error("unexpected throttle");

    const r = await app.inject({
      url: `/interaction/${uid}/callback?token=${issued.token}`,
      headers: { ...HOST, cookie: cookies },
    });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers.location)).toContain("/oidc/auth/");
  });

  it("негодный токен не пускает и не роняет сервер", async () => {
    const { uid, cookies } = await startInteraction();
    const r = await app.inject({
      url: `/interaction/${uid}/callback?token=подделка`,
      headers: { ...HOST, cookie: cookies },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("экран называет продукт по реестру, а не по имени клиента", () => {
  it("клиент ЗАПИСОК с произвольным именем показывает ЗАПИСКИ", async () => {
    // Прежде продукт угадывался по префиксу client_id: всё, что не
    // начинается с zapiski/moments, объявлялось ПРАКТИКОЙ. Клиент
    // ЗАПИСОК, названный «notes-desktop», показал бы человеку чужое
    // имя продукта — расхождение интерфейса и макета, то есть дефект
    // приёмки. В реестре для этого есть колонка product.
    const { serviceOf } = await import("../src/oidc/interactions.js");
    await getPool().query(
      `INSERT INTO oidc_clients
         (client_id, client_name, client_secret, redirect_uris, auth_method, first_party, product)
       VALUES ('notes-desktop', 'ЗАПИСКИ', $1, ARRAY['https://n.test/cb'],
               'client_secret_basic', false, 'zapiski')
       ON CONFLICT (client_id) DO NOTHING`,
      ["n".repeat(43)],
    );
    expect(await serviceOf("notes-desktop")).toBe("zapiski");
  });

  it("клиент без указанного продукта считается ПРАКТИКОЙ", async () => {
    expect(await serviceOf_("test")).toBe("practice");
  });

  it("неизвестный клиент не роняет экран", async () => {
    expect(await serviceOf_("нет-такого")).toBe("practice");
  });
});

async function serviceOf_(id: string): Promise<string> {
  const { serviceOf } = await import("../src/oidc/interactions.js");
  return serviceOf(id);
}
