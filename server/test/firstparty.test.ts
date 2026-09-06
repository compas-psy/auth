import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import {
  issueTokens, rotateRefresh, revokeSession, verifyAccessToken,
} from "../src/services/tokens.js";

let accountId: string;
beforeEach(async () => {
  await resetData();
  ({ accountId } = await createAccountWithEmail("n@ya.ru"));
});
afterAll(async () => { await closePool(); });

const dev = { deviceKey: "dev-1", platform: "android" as const, client: "app" };

describe("первичный токен-API", () => {
  it("refresh одноразовый: при обновлении выдаётся новый", async () => {
    const first = await issueTokens(accountId, dev);
    const second = await rotateRefresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
  });

  it("повторное использование refresh гасит всю цепочку устройства", async () => {
    const first = await issueTokens(accountId, dev);
    const second = await rotateRefresh(first.refresh_token);
    await expect(rotateRefresh(first.refresh_token)).rejects.toThrow();
    // Цепочка мертва целиком, а не только повторённый токен.
    await expect(rotateRefresh(second.refresh_token)).rejects.toThrow();
  });

  it("сырой refresh в базе не хранится", async () => {
    const t = await issueTokens(accountId, dev);
    const { rows } = await getPool().query("SELECT * FROM first_party_sessions");
    expect(JSON.stringify(rows)).not.toContain(t.refresh_token);
  });

  it("сырой access в базе тоже не хранится", async () => {
    const t = await issueTokens(accountId, dev);
    const { rows } = await getPool().query("SELECT * FROM first_party_sessions");
    expect(JSON.stringify(rows)).not.toContain(t.access_token);
  });

  it("гашение одного устройства не трогает другое", async () => {
    const a = await issueTokens(accountId, dev);
    const b = await issueTokens(accountId, { ...dev, deviceKey: "dev-2" });
    await expect(rotateRefresh(a.refresh_token)).resolves.toBeTruthy();
    await rotateRefresh(a.refresh_token).catch(() => {});
    // Гонка на первом устройстве не должна выкидывать со второго.
    await expect(rotateRefresh(b.refresh_token)).resolves.toBeTruthy();
  });

  it("отзыв сеанса из портала немедленно убивает refresh", async () => {
    const t = await issueTokens(accountId, dev);
    await revokeSession(accountId, t.session_id, "user_revoked");
    await expect(rotateRefresh(t.refresh_token)).rejects.toThrow();
  });

  it("access-токен проверяется и называет владельца", async () => {
    const t = await issueTokens(accountId, dev);
    const claims = await verifyAccessToken(t.access_token);
    expect(claims?.accountId).toBe(accountId);
  });

  it("подделанный access-токен не проходит", async () => {
    expect(await verifyAccessToken("не.токен.вовсе")).toBeNull();
  });

  it("access-токен отозванного сеанса перестаёт действовать", async () => {
    const t = await issueTokens(accountId, dev);
    await revokeSession(accountId, t.session_id, "user_revoked");
    expect(await verifyAccessToken(t.access_token)).toBeNull();
  });

  it("выпуск заводит строку устройства для экрана «Устройства и сеансы»", async () => {
    const t = await issueTokens(accountId, dev);
    const { rows } = await getPool().query(
      "SELECT platform, client FROM sessions WHERE id = $1", [t.session_id]);
    expect(rows[0].platform).toBe("android");
    expect(rows[0].client).toBe("app");
  });

  it("в схеме сеансов нет ни ip, ни user_agent", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'");
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("ip");
    expect(cols).not.toContain("user_agent");
    expect(cols).toContain("platform");
    expect(cols).toContain("client");
  });

  it("просроченный refresh не обновляется", async () => {
    const t = await issueTokens(accountId, dev);
    await getPool().query("UPDATE first_party_sessions SET expires_at = now() - interval '1 day'");
    await expect(rotateRefresh(t.refresh_token)).rejects.toThrow();
  });

  it("неизвестный refresh не обновляется и ничего не гасит", async () => {
    await issueTokens(accountId, dev);
    await expect(rotateRefresh("нет-такого")).rejects.toThrow();
    const { rows } = await getPool().query(
      "SELECT count(*)::int n FROM first_party_sessions WHERE revoked_at IS NOT NULL");
    expect(rows[0].n).toBe(0);
  });
});

describe("Н1: первичный API закрыт для чужих", () => {
  it("сторонний клиент получает 403 на /v1/auth/*", async () => {
    const { buildServer } = await import("../src/index.js");
    const { ensureTestClient } = await import("./helpers.js");
    await ensureTestClient();
    const app = await buildServer();
    await app.ready();
    const r = await app.inject({
      method: "POST", url: "/v1/auth/token/refresh",
      headers: { "x-client-id": "test" },
      payload: { refresh_token: "whatever" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("forbidden_client");
    await app.close();
  });

  it("клиент без имени тоже не допускается", async () => {
    const { buildServer } = await import("../src/index.js");
    const app = await buildServer();
    await app.ready();
    const r = await app.inject({
      method: "POST", url: "/v1/auth/token/refresh",
      payload: { refresh_token: "whatever" },
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it("свой клиент допускается и получает ответ по существу", async () => {
    const { buildServer } = await import("../src/index.js");
    const { ensureTestClient } = await import("./helpers.js");
    await ensureTestClient();
    const app = await buildServer();
    await app.ready();
    const t = await issueTokens(accountId, dev);
    const r = await app.inject({
      method: "POST", url: "/v1/auth/token/refresh",
      headers: { "x-client-id": "practice-mobile" },
      payload: { refresh_token: t.refresh_token },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().refresh_token).not.toBe(t.refresh_token);
    await app.close();
  });

  it("выход гасит сеанс и отвечает 204 даже на чужой токен", async () => {
    const { buildServer } = await import("../src/index.js");
    const { ensureTestClient } = await import("./helpers.js");
    await ensureTestClient();
    const app = await buildServer();
    await app.ready();
    const t = await issueTokens(accountId, dev);
    const headers = { "x-client-id": "practice-mobile" };
    const ok = await app.inject({
      method: "POST", url: "/v1/auth/logout", headers, payload: { refresh_token: t.refresh_token },
    });
    expect(ok.statusCode).toBe(204);
    await expect(rotateRefresh(t.refresh_token)).rejects.toThrow();

    const stranger = await app.inject({
      method: "POST", url: "/v1/auth/logout", headers, payload: { refresh_token: "нет-такого" },
    });
    expect(stranger.statusCode).toBe(204);
    await app.close();
  });
});
