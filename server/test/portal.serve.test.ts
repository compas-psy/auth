import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => { await ensureSchema(); app = await buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); await closePool(); });

describe("портал аккаунта отдаётся сервером", () => {
  it("обзор аккаунта открывается", async () => {
    const r = await app.inject({ url: "/account" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("каждый раздел портала имеет свой адрес", async () => {
    for (const section of ["personal", "security", "devices", "communications", "privacy"]) {
      const r = await app.inject({ url: `/account/${section}` });
      expect({ section, code: r.statusCode }).toEqual({ section, code: 200 });
    }
  });

  it("сведения об учётной записи не кэшируются", async () => {
    const r = await app.inject({ url: "/account/security" });
    expect(String(r.headers["cache-control"])).toContain("no-store");
  });

  it("собранный портал отдаётся по адресам из оболочки", async () => {
    const js = await app.inject({ url: "/assets/portal.js" });
    const css = await app.inject({ url: "/assets/portal.css" });
    expect(js.statusCode).toBe(200);
    expect(css.statusCode).toBe(200);
  });
});
