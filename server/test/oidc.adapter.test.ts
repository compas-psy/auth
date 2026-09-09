import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPool, closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";
import { PostgresAdapter } from "../src/oidc/adapter.js";

beforeEach(async () => {
  await ensureSchema();
  await getPool().query("TRUNCATE oidc_payloads");
});
afterAll(async () => { await closePool(); });

describe("адаптер хранения", () => {
  it("сохраняет и находит по id", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("c1", { grantId: "g1", foo: "bar" }, 60);
    expect((await a.find("c1"))?.foo).toBe("bar");
  });

  it("consume помечает погашенным, но не удаляет", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("c2", { grantId: "g2" }, 60);
    await a.consume("c2");
    expect((await a.find("c2"))?.consumed).toBeDefined();
  });

  it("consumed — секунды эпохи, как ждёт библиотека", async () => {
    // lib/adapters/memory_adapter.js:42 ставит epochTime() — СЕКУНДЫ.
    // Миллисекунды здесь дали бы код, «погашенный» в 55000 году.
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("c2s", { grantId: "g2s" }, 60);
    await a.consume("c2s");
    const consumed = (await a.find("c2s"))?.consumed as number;
    expect(Math.abs(consumed - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it("revokeByGrantId убирает все записи гранта", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    const r = new PostgresAdapter("RefreshToken");
    await a.upsert("c3", { grantId: "g3" }, 60);
    await r.upsert("r3", { grantId: "g3" }, 60);
    await a.revokeByGrantId("g3");
    expect(await a.find("c3")).toBeUndefined();
    // Отзыв гранта обязан уносить и токены других типов, иначе refresh
    // переживает отзыв разрешения.
    expect(await r.find("r3")).toBeUndefined();
  });

  it("revokeByGrantId не трогает чужой грант", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("keep", { grantId: "other" }, 60);
    await a.revokeByGrantId("g-missing");
    expect(await a.find("keep")).toBeDefined();
  });

  it("просроченная запись не находится", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("c4", { grantId: "g4" }, -1);
    expect(await a.find("c4")).toBeUndefined();
  });

  it("одинаковые id в разных типах не смешиваются", async () => {
    const code = new PostgresAdapter("AuthorizationCode");
    const token = new PostgresAdapter("RefreshToken");
    await code.upsert("same", { kind: "code" }, 60);
    await token.upsert("same", { kind: "token" }, 60);
    expect((await code.find("same"))?.kind).toBe("code");
    expect((await token.find("same"))?.kind).toBe("token");
  });

  it("upsert обновляет запись, а не заводит вторую", async () => {
    const a = new PostgresAdapter("Session");
    await a.upsert("s1", { uid: "u1", v: 1 }, 60);
    await a.upsert("s1", { uid: "u1", v: 2 }, 60);
    expect((await a.find("s1"))?.v).toBe(2);
    const { rows } = await getPool().query("SELECT count(*)::int n FROM oidc_payloads");
    expect(rows[0].n).toBe(1);
  });

  it("findByUid находит сессию, findByUserCode — код устройства", async () => {
    const s = new PostgresAdapter("Session");
    await s.upsert("s2", { uid: "uid-42" }, 60);
    expect((await s.findByUid("uid-42"))?.uid).toBe("uid-42");

    const d = new PostgresAdapter("DeviceCode");
    await d.upsert("d1", { userCode: "WDJB-MJHT" }, 60);
    expect((await d.findByUserCode("WDJB-MJHT"))?.userCode).toBe("WDJB-MJHT");
  });

  it("destroy удаляет запись", async () => {
    const a = new PostgresAdapter("AuthorizationCode");
    await a.upsert("c5", {}, 60);
    await a.destroy("c5");
    expect(await a.find("c5")).toBeUndefined();
  });

  it("запись без срока жизни хранится бессрочно и находится", async () => {
    // Эталонный адаптер объявляет expiresIn необязательным;
    // 'undefined seconds' в интервале уронило бы вставку.
    const g = new PostgresAdapter("Grant");
    await g.upsert("gr1", { grantId: "gr1" }, undefined as unknown as number);
    expect((await g.find("gr1"))?.grantId).toBe("gr1");
  });
});
