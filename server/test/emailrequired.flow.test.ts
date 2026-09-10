import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { registerWebProvider, clearWebProviders } from "../src/services/providers/registry.js";

/**
 * Экран «Нужна электронная почта» — не тупик.
 *
 * Ветка написана ради И-5: провайдер не дал подтверждённой почты, значит
 * учётную запись заводить нельзя, пока человек не назовёт и не
 * подтвердит адрес. Экран показывался — и на этом всё кончалось:
 *
 *   1. состояние экрана не содержало uid, и форма уходила в
 *      /interaction/undefined/email;
 *   2. личность провайдера нигде не запоминалась, поэтому даже после
 *      подтверждения почты человек при следующем входе тем же
 *      провайдером снова попадал на этот экран. Каждый раз.
 *
 * До сих пор сюда никто не доходил: и Яндекс, и VK считаются отдающими
 * подтверждённую почту. Первый же провайдер, который её не даст, упрётся
 * в это место.
 */

const sent: string[] = [];
vi.mock("../src/services/mailer.js", () => ({
  sendMagicLink: vi.fn(async (_to: string, url: string) => { sent.push(url); }),
  sendEmailCode: vi.fn(async () => {}),
  resetMailer: vi.fn(),
}));

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };
const VALID = new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

const SUBJECT = "y-без-почты";
const CLAIMED = "неподтверждённый@ya.ru";

function fakeProvider(email: string | null, verified: boolean) {
  registerWebProvider({
    provider: "yandex",
    authorizationUrl: (state) => `https://oauth.yandex.ru/authorize?state=${state}`,
    exchange: async () => ({ subject: SUBJECT, email, emailVerified: verified }),
  });
}

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => {
  await resetData(); await ensureTestClient();
  clearWebProviders(); sent.length = 0;
});
afterAll(async () => { clearWebProviders(); await app.close(); await closePool(); });

async function startInteraction(): Promise<{ uid: string; cookie: string }> {
  const r = await app.inject({ url: `/oidc/auth?${VALID}`, headers: HOST });
  const cookie = (r.headers["set-cookie"] as string[] | undefined ?? [])
    .map((c) => c.split(";")[0]).join("; ");
  return { uid: String(r.headers.location).replace("/interaction/", ""), cookie };
}

/** Доводит человека до экрана «Нужна электронная почта». */
async function reachEmailRequired() {
  const { uid, cookie } = await startInteraction();
  const start = await app.inject({
    url: `/interaction/${uid}/provider/yandex`, headers: { ...HOST, cookie } });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const back = await app.inject({
    url: `/callback/yandex?code=c&state=${encodeURIComponent(state)}`,
    headers: { ...HOST, cookie },
  });
  return { uid, cookie, back };
}

function stateOf(body: string): Record<string, unknown> {
  const m = /<script id="state" type="application\/json">(.*?)<\/script>/s.exec(body);
  return JSON.parse(m![1]!) as Record<string, unknown>;
}

describe("провайдер не дал подтверждённой почты", () => {
  it("экран знает, к какому входу он относится", async () => {
    fakeProvider(CLAIMED, false);
    const { uid, back } = await reachEmailRequired();
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("Нужна электронная почта");
    // Без uid форма уходит в /interaction/undefined/email, и человек
    // получает «Вход временно недоступен» вместо письма.
    expect(stateOf(back.body).uid).toBe(uid);
  });

  it("подставляет адрес, который провайдер всё-таки назвал", async () => {
    // Человеку остаётся нажать кнопку, а не набирать заново то, что
    // система уже знает.
    fakeProvider(CLAIMED, false);
    const { back } = await reachEmailRequired();
    expect(stateOf(back.body).email).toBe(CLAIMED);
  });

  it("после подтверждения почты личность провайдера ПРИВЯЗЫВАЕТСЯ", async () => {
    fakeProvider(CLAIMED, false);
    const { uid, cookie } = await reachEmailRequired();

    const asked = await app.inject({
      method: "POST", url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie }, payload: { email: CLAIMED },
    });
    expect(asked.statusCode).toBe(200);
    expect(sent).toHaveLength(1);

    const done = await app.inject({
      url: new URL(sent[0]!).pathname + new URL(sent[0]!).search,
      headers: { ...HOST, cookie },
    });
    expect(done.statusCode, done.body).toBe(303);

    const { rows } = await getPool().query(
      "SELECT provider, subject FROM identities WHERE subject = $1", [SUBJECT]);
    expect(rows[0], "личность провайдера не привязалась — человек вернётся на тот же экран")
      .toMatchObject({ provider: "yandex", subject: SUBJECT });
  });

  it("второй вход тем же провайдером проходит насквозь", async () => {
    fakeProvider(CLAIMED, false);
    const { uid, cookie } = await reachEmailRequired();
    await app.inject({
      method: "POST", url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie }, payload: { email: CLAIMED } });
    const link = new URL(sent[0]!);
    await app.inject({ url: link.pathname + link.search, headers: { ...HOST, cookie } });

    // Теперь провайдер отдаёт то же самое — и экран почты больше не нужен.
    const second = await reachEmailRequired();
    expect(second.back.body).not.toContain("Нужна электронная почта");
    expect(second.back.statusCode).toBe(303);
  });
});
