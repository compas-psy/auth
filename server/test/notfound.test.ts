import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => { await ensureSchema(); app = await buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); await closePool(); });

const BROWSER = { accept: "text/html,application/xhtml+xml" };

describe("человек не видит машинную ошибку", () => {
  it("корень уводит в аккаунт, а не отвечает not_found", async () => {
    // https://auth.cmpas.ru/ отдавал {"error":"not_found"} — человеку
    // показывалась машинная ошибка на домене, куда он пришёл входить.
    const r = await app.inject({ url: "/", headers: BROWSER });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/account");
  });

  it("несуществующий адрес в браузере — человеческий экран", async () => {
    const r = await app.inject({ url: "/нет-такой-страницы", headers: BROWSER });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).not.toContain("not_found");
  });

  it("тот же адрес для программы — по-прежнему JSON", async () => {
    // Продукт и SDK разбирают ответ машинно: подсовывать им страницу
    // вместо кода ошибки значит сломать разбор.
    const r = await app.inject({ url: "/v1/нет-такой-ручки" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "not_found" });
  });

  it("экран отказа не рассказывает о внутреннем устройстве", async () => {
    const r = await app.inject({ url: "/нет-такой-страницы", headers: BROWSER });
    for (const leak of ["postgres", "ECONNREFUSED", "/var/", "node_modules", "at Object."]) {
      expect({ leak, found: r.body.includes(leak) }).toEqual({ leak, found: false });
    }
  });
});
