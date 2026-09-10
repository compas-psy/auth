import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";

/**
 * Выход из личного кабинета обязан существовать.
 *
 * Макет требует: «Возврат в продукт всегда виден. Портал не ловушка»
 * (09_ACCOUNT_DESIGN_ADDENDUM.md §168). Ссылка была на каждом экране —
 * и вела в /return/practice, маршрута для которого на сервере нет.
 * Проверено запросом к собранному серверу: 404, {"error":"not_found"}.
 * Ловушкой портал быть перестаёт только тогда, когда дверь открывается.
 *
 * Мест со ссылкой три: шапка каждого экрана, «Открыть» у продукта в
 * обзоре и «Открыть ПРАКТИКУ» в личных данных.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };
const BROWSER = { ...HOST, accept: "text/html,application/xhtml+xml" };

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
afterAll(async () => { if (app) await app.close(); await closePool(); });

describe("возврат в продукт", () => {
  it("уводит в ПРАКТИКУ, а не в 404", async () => {
    const r = await app.inject({ url: "/return/practice", headers: BROWSER });
    expect(r.statusCode).toBe(302);
    expect(String(r.headers.location)).toBe("https://cmpas.ru");
  });

  it("продукт без известного адреса не обещает двери", async () => {
    // ЗАПИСКИ работают полностью офлайн (И-4): веб-адреса у них нет и
    // быть не может. Честный отказ лучше ссылки в пустоту.
    const r = await app.inject({ url: "/return/zapiski", headers: BROWSER });
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain("Такой страницы нет");
  });

  it("в параметр нельзя подставить чужой адрес", async () => {
    // У-3: открытый редирект. Принимается только код продукта.
    for (const bad of ["https://evil.test", "//evil.test", "practice/../../x"]) {
      const r = await app.inject({ url: `/return/${encodeURIComponent(bad)}`, headers: BROWSER });
      expect({ bad, code: r.statusCode }).toEqual({ bad, code: 404 });
    }
  });

  it("человеку — экран, программе — код", async () => {
    const r = await app.inject({ url: "/return/нет-такого", headers: HOST });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "not_found" });
  });
});

describe("откуда человек пришёл в кабинет", () => {
  function stateOf(body: string): Record<string, unknown> {
    const m = /<script id="state" type="application\/json">(.*?)<\/script>/s.exec(body);
    return JSON.parse(m![1]!) as Record<string, unknown>;
  }

  it("пришедшему напрямую не предлагают вернуться в ПРАКТИКУ", async () => {
    // Человек набрал auth.cmpas.ru, чтобы посмотреть свою учётную
    // запись. Он не приходил из ПРАКТИКИ, и звать его «обратно» туда —
    // выдумка про его путь.
    const r = await app.inject({ url: "/account", headers: BROWSER });
    expect(stateOf(r.body).service).toBe("account");
  });

  it("пришедшего из продукта возвращают в ЕГО продукт", async () => {
    const r = await app.inject({ url: "/account?return_to=zapiski", headers: BROWSER });
    expect(stateOf(r.body).service).toBe("zapiski");
  });

  it("ШАГИ — такой же продукт, как остальные", async () => {
    // Продукт заведён миграцией 0011, а разбор параметра его не знал:
    // человек из ШАГОВ молча становился человеком из ПРАКТИКИ.
    const r = await app.inject({ url: "/account?return_to=steps", headers: BROWSER });
    expect(stateOf(r.body).service).toBe("steps");
  });

  it("подставленное значение не проходит", async () => {
    const r = await app.inject({ url: "/account?return_to=https://evil.test", headers: BROWSER });
    expect(stateOf(r.body).service).toBe("account");
  });
});
