import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";

/**
 * Ресурс разработчика собирается (devsite/dist), копируется в образ и
 * для него задан DEVSITE_DIST — но ни одна строка кода его не отдавала,
 * и …/dev отвечал 404. CLAUDE.md называет его частью поверхности
 * сервиса наравне с порталом; собранное и недоступное — это брак.
 */
describe("ресурс разработчика доступен по /dev", () => {
  let app: FastifyInstance;
  beforeAll(async () => { await ensureSchema(); app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); await closePool(); });

  it("отдаёт начальную страницу", async () => {
    const r = await app.inject({ url: "/dev/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("без косой черты — перенаправляет на неё", async () => {
    // Не отдаёт содержимое по обоим адресам: относительные ссылки
    // внутри страницы считаются от каталога, и без косой черты
    // справочник разъезжается.
    const r = await app.inject({ url: "/dev" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/dev/");
  });

  it("отдаёт страницу справочника", async () => {
    const r = await app.inject({ url: "/dev/reference/account-emails.html" });
    expect(r.statusCode).toBe(200);
  });

  it("отдаёт спецификацию — единственный источник истины", async () => {
    const r = await app.inject({ url: "/dev/simpasid.v1.yaml" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("openapi:");
  });

  it("не выпускает наружу файлы выше своего каталога", async () => {
    // Отдача статики по пути из запроса — классический способ
    // случайно раздать /etc/passwd или ключи подписи.
    for (const url of [
      "/dev/../package.json",
      "/dev/%2e%2e/package.json",
      "/dev/../../../../etc/passwd",
    ]) {
      const r = await app.inject({ url });
      expect({ url, ok: r.statusCode === 200 && r.body.includes("root:") })
        .toEqual({ url, ok: false });
    }
  });

  it("страницы справочника не кэшируются намертво", async () => {
    // Справочник генерируется из спецификации и меняется с ней.
    const r = await app.inject({ url: "/dev/reference/account-emails.html" });
    expect(r.headers["cache-control"] ?? "").not.toContain("immutable");
  });
});
