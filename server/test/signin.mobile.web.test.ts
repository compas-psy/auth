import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { registerWebProvider, clearWebProviders } from "../src/services/providers/registry.js";
import { clearNativeAdapters } from "../src/services/providers/native.js";
import type { YandexAdapter } from "../src/services/providers/yandex.js";

/**
 * Экран входа в ТЕЛЕФОННОМ БРАУЗЕРЕ показывает те же способы, что и на
 * настольном.
 *
 * Учредитель открыл auth.cmpas.ru с телефона и увидел объяснение про
 * внешний сервис — над пустым местом, где должен быть знак Яндекса.
 * Причина: состав способов считался по платформе УСТРОЙСТВА, и
 * телефонный браузер попадал в мобильную ветку, где провайдер без
 * нативного SDK не показывается.
 *
 * Правило «без SDK не показываем» относится к НАШЕМУ ПРИЛОЖЕНИЮ
 * (12_NATIVE_AUTH.md §2.2): там вход идёт через SDK провайдера, и без
 * SDK показывать нечего. В браузере вход идёт редиректом, и редирект на
 * телефоне работает ровно так же, как на столе. Применив правило
 * приложения к браузеру, мы отняли у человека с телефоном
 * работающий способ войти.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

// Живой Chrome на Android — тот самый случай со снимка.
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

const VALID = new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => {
  await resetData(); await ensureTestClient();
  clearWebProviders(); clearNativeAdapters();
  // Ключи Яндекса на сервере есть — значит подключён веб-провайдер.
  // Нативного SDK нет ни одного: их наличие не проверено.
  const adapter: YandexAdapter = {
    provider: "yandex",
    authorizationUrl: (state) => `https://oauth.yandex.ru/authorize?state=${state}`,
    exchange: vi.fn(async () => ({ subject: "y", email: "y@ya.ru", emailVerified: true })),
  };
  registerWebProvider(adapter);
});
afterAll(async () => {
  clearWebProviders(); clearNativeAdapters();
  await app.close(); await closePool();
});

async function screenFor(userAgent: string): Promise<string> {
  const start = await app.inject({ url: `/oidc/auth?${VALID}`, headers: HOST });
  const uid = String(start.headers.location).replace("/interaction/", "");
  const cookies = (start.headers["set-cookie"] as string[] | undefined ?? [])
    .map((c) => c.split(";")[0]).join("; ");
  const r = await app.inject({
    url: `/interaction/${uid}`,
    headers: { ...HOST, cookie: cookies, "user-agent": userAgent },
  });
  return r.body;
}

describe("экран входа в телефонном браузере", () => {
  it("предлагает вход через Яндекс так же, как настольный", async () => {
    expect(await screenFor(ANDROID)).toContain("yandex");
  });

  it("состав способов не зависит от того, с чего человек пришёл", async () => {
    const phone = /"providers":\[[^\]]*\]/.exec(await screenFor(ANDROID))?.[0];
    const desk = /"providers":\[[^\]]*\]/.exec(await screenFor(DESKTOP))?.[0];
    expect(phone).toBeDefined();
    expect(phone).toBe(desk);
  });

  it("объяснению про внешний сервис есть что объяснять", async () => {
    const body = await screenFor(ANDROID);
    // Строку про провайдера убирать нельзя — она есть на всех
    // артбордах. Значит на экране обязан быть и сам провайдер,
    // иначе объяснение висит над пустым местом.
    expect(body).toContain("Провайдер увидит");
    expect(/"providers":\[\]/.test(body)).toBe(false);
  });
});
