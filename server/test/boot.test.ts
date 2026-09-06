import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";

afterAll(async () => { await closePool(); });

describe("каркас сервиса", () => {
  it("health-check отвечает 200 и называет issuer", async () => {
    const app = await buildServer({ migrate: true });
    await app.ready();
    const r = await app.inject({ url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", issuer: "https://auth.cmpas.ru" });
    await app.close();
  });

  it("миграции идемпотентны: повторный прогон ничего не применяет", async () => {
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations();
    expect(await runMigrations()).toEqual([]);
  });
});
