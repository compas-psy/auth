import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken, authHeaders } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createAccountWithEmail } from "../src/services/accounts.js";

let app: FastifyInstance;
let accountId: string;
let auth: Record<string, string>;

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => {
  await resetData();
  ({ accountId } = await createAccountWithEmail("id@ya.ru"));
  auth = authHeaders((await issueTestToken(accountId)).token);
});
afterAll(async () => { await app.close(); await closePool(); });

describe("Т6: последний способ входа не отвязывается", () => {
  it("отвязка провайдера при отсутствии подтверждённой почты отклоняется", async () => {
    // Учётная запись с провайдером и без verified-почты — прямо в базе:
    // штатным путём такая не заводится, но проверять надо именно её.
    const { rows: idn } = await getPool().query<{ id: string }>(
      `INSERT INTO identities (account_id, provider, subject)
       VALUES ($1,'yandex','y-1') RETURNING id`, [accountId]);
    const identityId = idn[0]!.id;
    await getPool().query(
      "UPDATE account_emails SET verified_at = NULL WHERE account_id = $1", [accountId]);

    const r = await app.inject({
      method: "DELETE", url: `/v1/account/identities/${identityId}`, headers: auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("last_login_method");
  });

  it("при подтверждённой почте провайдер отвязывается", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO identities (account_id, provider, subject)
       VALUES ($1,'yandex','y-2') RETURNING id`, [accountId]);
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/identities/${rows[0]!.id}`, headers: auth });
    expect(r.statusCode).toBe(204);
  });

  it("отказ приходит от сервера, а не от интерфейса", async () => {
    // Кнопка не может быть просто неактивной: кадр «отказ» обязан
    // существовать, а значит и ответ сервера тоже.
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO identities (account_id, provider, subject)
       VALUES ($1,'yandex','y-3') RETURNING id`, [accountId]);
    await getPool().query(
      "UPDATE account_emails SET verified_at = NULL WHERE account_id = $1", [accountId]);
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/identities/${rows[0]!.id}`, headers: auth });
    expect(r.statusCode).toBe(409);
    const { rows: still } = await getPool().query(
      "SELECT count(*)::int n FROM identities WHERE account_id = $1", [accountId]);
    expect(still[0].n).toBe(1);
  });
});

describe("У-2: один аккаунт провайдера — одна учётная запись", () => {
  it("привязка занятого субъекта отклоняется", async () => {
    const other = await createAccountWithEmail("owner@ya.ru");
    await getPool().query(
      `INSERT INTO identities (account_id, provider, subject)
       VALUES ($1,'yandex','already-linked-subject')`, [other.accountId]);

    const r = await app.inject({
      method: "POST", url: "/v1/account/identities/yandex/link",
      headers: auth, payload: { subject: "already-linked-subject" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("identity_taken");
  });

  it("свободный субъект привязывается и виден в перечне", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/account/identities/yandex/link",
      headers: auth, payload: { subject: "free-subject", email_at_link: "t@ya.ru" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().provider).toBe("yandex");
    const list = await app.inject({ url: "/v1/account/identities", headers: auth });
    expect(list.json().identities).toHaveLength(1);
  });

  it("тот же субъект у того же аккаунта дважды не привязывается", async () => {
    const payload = { subject: "twice" };
    await app.inject({ method: "POST", url: "/v1/account/identities/yandex/link",
      headers: auth, payload });
    const second = await app.inject({ method: "POST",
      url: "/v1/account/identities/yandex/link", headers: auth, payload });
    expect(second.statusCode).toBe(409);
  });

  it("один субъект в разных сервисах — разные способы входа", async () => {
    await app.inject({ method: "POST", url: "/v1/account/identities/yandex/link",
      headers: auth, payload: { subject: "same-id" } });
    const r = await app.inject({ method: "POST", url: "/v1/account/identities/tid/link",
      headers: auth, payload: { subject: "same-id" } });
    expect(r.statusCode).toBe(200);
  });

  it("неизвестный сервис отклоняется", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/account/identities/facebook/link",
      headers: auth, payload: { subject: "x" } });
    expect(r.statusCode).toBe(400);
  });

  it("привязка невозможна без открытой сессии владельца", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/account/identities/yandex/link",
      payload: { subject: "no-session" } });
    expect(r.statusCode).toBe(401);
  });

  it("чужой способ входа не отвязывается", async () => {
    const other = await createAccountWithEmail("victim@ya.ru");
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO identities (account_id, provider, subject)
       VALUES ($1,'yandex','victims') RETURNING id`, [other.accountId]);
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/identities/${rows[0]!.id}`, headers: auth });
    expect(r.statusCode).toBe(404);
  });

  it("токены провайдера не сохраняются: колонок под них нет", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'identities'");
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("access_token");
    expect(cols).not.toContain("refresh_token");
  });
});
