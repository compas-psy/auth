import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { registerWebProvider, clearWebProviders, issueLoginState } from "../src/services/providers/registry.js";
import type { WebProviderAdapter } from "../src/services/providers/registry.js";

/**
 * Возврат от VK доносит device_id до обмена.
 *
 * Без него VK обмен не проводит. Маршрут возврата раньше знал только
 * про code и state — то есть для VK был бы заведомо неработающим, и
 * человек получал бы «Войти этим способом не получилось» без всякого
 * объяснения, почему.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const VALID = new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

function fakeVk(): { adapter: WebProviderAdapter; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const adapter: WebProviderAdapter = {
    provider: "vkid",
    authorizationUrl: (state) => `https://id.vk.ru/authorize?state=${state}`,
    exchange: vi.fn(async (params) => {
      seen.push({ ...params });
      return { subject: "vk-1", email: "vk@ya.ru", emailVerified: true };
    }),
  };
  return { adapter, seen };
}

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => {
  await resetData(); await ensureTestClient(); clearWebProviders();
});
afterAll(async () => { clearWebProviders(); await app.close(); await closePool(); });

/**
 * Возврат от провайдера идёт с теми же cookie, что и у браузера:
 * без них взаимодействие не находится, и проверка краснела бы по
 * причине, к VK отношения не имеющей.
 */
async function startInteraction(): Promise<{ uid: string; cookie: string }> {
  const r = await app.inject({ url: `/oidc/auth?${VALID}`, headers: HOST });
  const cookie = (r.headers["set-cookie"] as string[] | undefined ?? [])
    .map((c) => c.split(";")[0]).join("; ");
  return { uid: String(r.headers.location).replace("/interaction/", ""), cookie };
}

describe("возврат от VK", () => {
  it("device_id доходит до обмена", async () => {
    const { adapter, seen } = fakeVk();
    registerWebProvider(adapter);
    const { uid, cookie } = await startInteraction();
    const state = await issueLoginState("vkid", uid);

    const r = await app.inject({
      url: `/callback/vkid?code=vk-code&state=${encodeURIComponent(state)}&device_id=dev-42`,
      headers: { ...HOST, cookie },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: "vk-code", state, deviceId: "dev-42" });
    expect(r.statusCode).toBe(303);
  });

  it("кнопка VK появляется на экране входа, когда провайдер подключён", async () => {
    const { adapter } = fakeVk();
    registerWebProvider(adapter);
    const { uid, cookie } = await startInteraction();
    const screen = await app.inject({
      url: `/interaction/${uid}`, headers: { ...HOST, cookie },
    });
    expect(screen.body).toContain("vkid");
  });

  it("возврат без device_id не выдаёт вход за состоявшийся", async () => {
    // Адаптер VK такой возврат отвергает; маршрут обязан показать
    // человеку экран отказа, а не молча завести сеанс.
    const adapter: WebProviderAdapter = {
      provider: "vkid",
      authorizationUrl: (s) => `https://id.vk.ru/authorize?state=${s}`,
      exchange: vi.fn(async () => { throw new Error("возврат без device_id"); }),
    };
    registerWebProvider(adapter);
    const { uid, cookie } = await startInteraction();
    const state = await issueLoginState("vkid", uid);

    const r = await app.inject({
      url: `/callback/vkid?code=vk-code&state=${encodeURIComponent(state)}`,
      headers: { ...HOST, cookie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("Войти этим способом не получилось");
  });
});
