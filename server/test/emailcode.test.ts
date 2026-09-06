import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { issueEmailCode, verifyEmailCode, CODE_TTL_MINUTES, MAX_ATTEMPTS }
  from "../src/services/emailCode.js";

let app: FastifyInstance;
const FIRST_PARTY = { "x-client-id": "practice-mobile" };
const req = { email: "code@ya.ru", deviceKey: "dev-1", platform: "android" as const };

beforeEach(async () => {
  await resetData();
  await ensureTestClient();
  if (!app) { app = await buildServer(); await app.ready(); }
});
afterAll(async () => { if (app) await app.close(); await closePool(); });

function code(r: Awaited<ReturnType<typeof issueEmailCode>>): string {
  if ("throttled" in r) throw new Error("unexpected throttle");
  return r.code;
}

describe("вход по коду из письма", () => {
  it("сырой код в базе не хранится", async () => {
    const c = code(await issueEmailCode(req));
    const { rows } = await getPool().query("SELECT * FROM magic_link_tokens");
    expect(JSON.stringify(rows)).not.toContain(c);
  });

  it("код — шесть цифр", async () => {
    expect(code(await issueEmailCode(req))).toMatch(/^\d{6}$/);
  });

  it("срок жизни кода — 10 минут, а не 15", async () => {
    expect(CODE_TTL_MINUTES).toBe(10);
    await issueEmailCode(req);
    const { rows } = await getPool().query(
      "SELECT expires_at - created_at AS ttl FROM magic_link_tokens");
    expect(rows[0].ttl.minutes).toBe(10);
  });

  it("верный код пускает", async () => {
    const c = code(await issueEmailCode(req));
    const out = await verifyEmailCode({ email: req.email, code: c, deviceKey: req.deviceKey });
    expect("accountId" in out).toBe(true);
  });

  it("после пятой неверной попытки код гасится безвозвратно", async () => {
    const c = code(await issueEmailCode(req));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyEmailCode({ email: req.email, code: "000000", deviceKey: req.deviceKey });
    }
    const good = await verifyEmailCode({ email: req.email, code: c, deviceKey: req.deviceKey });
    expect(good).toEqual({ error: "too_many_attempts" });
  });

  it("счётчик попыток живёт на строке кода, а не в памяти процесса", async () => {
    await issueEmailCode(req);
    await verifyEmailCode({ email: req.email, code: "000000", deviceKey: req.deviceKey });
    const { rows } = await getPool().query(
      "SELECT attempts FROM magic_link_tokens WHERE lower(email) = lower($1)", [req.email]);
    expect(rows[0].attempts).toBe(1);
  });

  it("неверная попытка называет остаток, пока он есть", async () => {
    await issueEmailCode(req);
    const out = await verifyEmailCode({ email: req.email, code: "000000", deviceKey: req.deviceKey });
    expect(out).toEqual({ error: "invalid_code", attemptsLeft: MAX_ATTEMPTS - 1 });
  });

  it("код привязан к устройству, на котором начат вход", async () => {
    const c = code(await issueEmailCode(req));
    const out = await verifyEmailCode({ email: req.email, code: c, deviceKey: "чужое-устройство" });
    expect("error" in out).toBe(true);
  });

  it("код одноразовый", async () => {
    const c = code(await issueEmailCode(req));
    await verifyEmailCode({ email: req.email, code: c, deviceKey: req.deviceKey });
    const again = await verifyEmailCode({ email: req.email, code: c, deviceKey: req.deviceKey });
    expect("error" in again).toBe(true);
  });

  it("просроченный код не пускает", async () => {
    const c = code(await issueEmailCode(req));
    await getPool().query("UPDATE magic_link_tokens SET expires_at = now() - interval '1 minute'");
    const out = await verifyEmailCode({ email: req.email, code: c, deviceKey: req.deviceKey });
    expect("error" in out).toBe(true);
  });

  it("колонки otp в схеме нет: код живёт в token_hash", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'magic_link_tokens'");
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("otp");
    expect(cols).not.toContain("code");
    expect(cols).toContain("token_hash");
    expect(cols).toContain("attempts");
  });
});

describe("маршруты нативного входа по почте", () => {
  it("start отвечает 202 и для несуществующего адреса", async () => {
    const a = await app.inject({
      method: "POST", url: "/v1/auth/email/start", headers: FIRST_PARTY,
      payload: { email: "never-existed@ya.ru", device_key: "d", platform: "android" },
    });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toEqual({ retry_after_seconds: 60 });
  });

  it("start отвечает одинаково для существующего и несуществующего адреса", async () => {
    const known = await app.inject({
      method: "POST", url: "/v1/auth/email/start", headers: FIRST_PARTY,
      payload: { email: "known@ya.ru", device_key: "d1", platform: "android" },
    });
    const unknown = await app.inject({
      method: "POST", url: "/v1/auth/email/start", headers: FIRST_PARTY,
      payload: { email: "unknown@ya.ru", device_key: "d2", platform: "android" },
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
  });

  it("повтор чаще паузы всё равно отвечает 202: пауза не оракул", async () => {
    const payload = { email: "rate@ya.ru", device_key: "d", platform: "android" };
    await app.inject({ method: "POST", url: "/v1/auth/email/start", headers: FIRST_PARTY, payload });
    const second = await app.inject({
      method: "POST", url: "/v1/auth/email/start", headers: FIRST_PARTY, payload });
    expect(second.statusCode).toBe(202);
  });

  it("verify возвращает пару токенов и профиль", async () => {
    const c = code(await issueEmailCode({ ...req, email: "verify@ya.ru" }));
    const r = await app.inject({
      method: "POST", url: "/v1/auth/email/verify", headers: FIRST_PARTY,
      payload: { email: "verify@ya.ru", code: c, device_key: req.deviceKey },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().access_token).toBeTruthy();
    expect(r.json().refresh_token).toBeTruthy();
    expect(r.json().account.email).toBe("verify@ya.ru");
  });

  it("неверный код — 400 invalid_code, исчерпание — 429 too_many_attempts", async () => {
    await issueEmailCode({ ...req, email: "att@ya.ru" });
    const payload = { email: "att@ya.ru", code: "000000", device_key: req.deviceKey };
    const bad = await app.inject({
      method: "POST", url: "/v1/auth/email/verify", headers: FIRST_PARTY, payload });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_code");

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await app.inject({ method: "POST", url: "/v1/auth/email/verify", headers: FIRST_PARTY, payload });
    }
    const done = await app.inject({
      method: "POST", url: "/v1/auth/email/verify", headers: FIRST_PARTY, payload });
    expect(done.statusCode).toBe(429);
    expect(done.json().error).toBe("too_many_attempts");
  });

  it("сторонний клиент не допускается к входу по коду", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/auth/email/start", headers: { "x-client-id": "test" },
      payload: { email: "n@ya.ru", device_key: "d", platform: "android" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("на мобильной платформе провайдер без SDK не показывается", async () => {
    const r = await app.inject({ url: "/v1/auth/methods?platform=android", headers: FIRST_PARTY });
    expect(r.json().providers).not.toContain("sberid");
    // Вход по почте доступен всегда — это И-5.
    expect(r.json().email).toBe(true);
  });
});
