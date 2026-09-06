import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken, authHeaders } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { rotateRefresh, issueTokens, verifyAccessToken } from "../src/services/tokens.js";
import { errors } from "../src/ui/wording.js";

let app: FastifyInstance;
let accountId: string;

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
  ({ accountId } = await createAccountWithEmail("degrade@ya.ru"));
});
afterAll(async () => { await app.close(); await closePool(); });

describe("Т8: недоступность SimpasID не разлогинивает", () => {
  it("продление сессии продукта не обращается к issuer", async () => {
    // Продукт продлевает свою сессию своим refresh-токеном. Проверяем,
    // что в нашем контуре продления нет ни одного обращения к issuer:
    // именно поэтому суточная недоступность никого не разлогинивает.
    const pair = await issueTokens(accountId, {
      deviceKey: "d", platform: "android", client: "app" });
    const rotated = await rotateRefresh(pair.refresh_token);
    expect(rotated.access_token).toBeTruthy();

    const source = (await import("node:fs")).readFileSync(
      new URL("../src/services/tokens.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("проверка ключа доступа не требует сетевого вызова", async () => {
    const pair = await issueTokens(accountId, {
      deviceKey: "d2", platform: "windows", client: "chrome" });
    expect((await verifyAccessToken(pair.access_token))?.accountId).toBe(accountId);
  });

  it("новый вход при недоступной базе показывает человеческий текст", () => {
    // Экран C4 берётся из реестра формулировок, а не собирается на месте.
    expect(errors.unavailableTitle).toBe("Вход временно недоступен. Мы уже чиним.");
    expect(errors.unavailable).toBe("Попробуйте через несколько минут.");
    expect(errors.unavailableZapiski).toBe("Заметки на этом устройстве работают как обычно.");
    for (const text of Object.values(errors)) {
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toMatch(/Error|undefined|null/);
    }
  });

  it("health-check отвечает 503, а не падает, когда база недоступна", async () => {
    const pool = getPool();
    const original = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const r = await app.inject({ url: "/healthz" });
      expect(r.statusCode).toBe(503);
      // Причина наружу не уходит: строка подключения — это адрес и имя базы.
      expect(r.body).not.toContain("ECONNREFUSED");
      expect(r.json()).toEqual({ status: "degraded" });
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
  });

  it("экран входа при недоступной базе не отдаёт стек", async () => {
    const pool = getPool();
    const original = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = async () => {
      throw new Error("ECONNREFUSED at /var/lib/postgresql");
    };
    try {
      const r = await app.inject({
        url: "/account",
        headers: {
          host: "auth.cmpas.ru", "x-forwarded-proto": "https", accept: "text/html",
        },
      });
      expect(r.body).not.toContain("ECONNREFUSED");
      expect(r.body).not.toContain("/var/lib/postgresql");
      // И вместо стека — тот самый человеческий текст экрана C4.
      expect(r.body).toContain("Вход временно недоступен. Мы уже чиним.");
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
  });

  it("API отвечает 401, а не 500, когда ключ доступа не проверить", async () => {
    const { token } = await issueTestToken(accountId);
    const pool = getPool();
    const original = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = async () => { throw new Error("down"); };
    try {
      const r = await app.inject({ url: "/v1/account", headers: authHeaders(token) });
      expect([401, 503]).toContain(r.statusCode);
      expect(r.statusCode).not.toBe(500);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
  });
});
