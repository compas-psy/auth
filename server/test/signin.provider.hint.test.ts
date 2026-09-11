import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { clearWebProviders, registerWebProvider } from "../src/services/providers/registry.js";

/**
 * Подсказка провайдера в запросе авторизации.
 *
 * Просьба агента ПРАКТИКИ от 11.09.2026: у них на экране два кружка —
 * Яндекс и VK, — и кружок VK не может вести в общий список, иначе он
 * обещает одно, а показывает другое.
 *
 * Подсказка ВЫБИРАЕТ, а не пропускает. Пользовательское соглашение
 * принимается действием на нашем экране и больше нигде (§1
 * 14_LEGAL_PRODUCTS_UNIFIED.md): уведи человека прямо к провайдеру —
 * и юридической строки он не увидит, а брать акцепт будет негде.
 */
let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const FAKE = (provider: "yandex" | "vkid") => ({
  provider,
  authorizationUrl: (state: string) => `https://${provider}.test/auth?state=${state}`,
  exchange: async () => ({ subject: "s", email: "a@ya.ru", emailVerified: true }),
});

function authUrl(extra: Record<string, string> = {}): string {
  return "/oidc/auth?" + new URLSearchParams({
    client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
    scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "st", nonce: "nc", ...extra,
  });
}

async function screenFor(extra: Record<string, string> = {}) {
  const start = await app.inject({ url: authUrl(extra), headers: HOST });
  const raw = start.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [String(raw ?? "")])
    .map((c) => c.split(";")[0]).join("; ");
  const uid = String(start.headers.location).replace("/interaction/", "");
  const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie } });
  const json = /<script id="state" type="application\/json">(.*?)<\/script>/s.exec(r.body)![1]!;
  return { response: r, state: JSON.parse(json.replace(/\\u003c/g, "<")) };
}

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  const { buildServer } = await import("../src/index.js");
  app = await buildServer();
  await app.ready();
  clearWebProviders();
  registerWebProvider(FAKE("yandex"));
  registerWebProvider(FAKE("vkid"));
});
afterAll(async () => { clearWebProviders(); await app.close(); await closePool(); });

describe("подсказка провайдера", () => {
  it("названный провайдер приходит на экран выделенным", async () => {
    const { state } = await screenFor({ provider: "vkid" });
    expect(state.focusProvider).toBe("vkid");
  });

  it("экран всё равно показывается: подсказка не уводит к провайдеру сама", async () => {
    // Уход прямо к провайдеру пропустил бы юридическую строку, и
    // акцепт соглашения брать было бы негде.
    const { response } = await screenFor({ provider: "vkid" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-testid="legal-line"');
  });

  it("остальные способы входа никуда не деваются", async () => {
    // И-5: подтверждённая почта — всегда доступный способ входа.
    // Подсказка не вправе его спрятать.
    const { state } = await screenFor({ provider: "vkid" });
    expect(state.providers).toEqual(["yandex", "vkid"]);
  });

  it("без подсказки экран прежний", async () => {
    const { state, response } = await screenFor();
    expect(state.focusProvider).toBeUndefined();
    expect(response.statusCode).toBe(200);
  });

  it("выдуманный провайдер не ломает вход, а просто не выделяет никого", async () => {
    // Опечатка в ссылке продукта не должна превращаться в отказ входа.
    const { state, response } = await screenFor({ provider: "нет-такого" });
    expect(response.statusCode).toBe(200);
    expect(state.focusProvider).toBeUndefined();
  });

  it("неподключённый провайдер не выделяется", async () => {
    clearWebProviders();
    registerWebProvider(FAKE("yandex"));
    try {
      const { state } = await screenFor({ provider: "vkid" });
      expect(state.focusProvider).toBeUndefined();
      expect(state.providers).toEqual(["yandex"]);
    } finally {
      registerWebProvider(FAKE("vkid"));
    }
  });
});
