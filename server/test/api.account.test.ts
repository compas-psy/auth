import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken, authHeaders } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createAccountWithEmail, linkProduct } from "../src/services/accounts.js";

let app: FastifyInstance;
let accountId: string;
let auth: Record<string, string>;

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  app = await buildServer();
  await app.ready();
});
beforeEach(async () => {
  await resetData();
  ({ accountId } = await createAccountWithEmail("api@ya.ru"));
  auth = authHeaders((await issueTestToken(accountId)).token);
});
afterAll(async () => { await app.close(); await closePool(); });

describe("GET /v1/account", () => {
  it("отдаёт профиль с подключёнными продуктами", async () => {
    await linkProduct(accountId, "practice", "u-1");
    const r = await app.inject({ url: "/v1/account", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ email: "api@ya.ru", email_verified: true });
    expect(r.json().products).toEqual(["practice"]);
  });

  it("без ключа отвечает 401", async () => {
    expect((await app.inject({ url: "/v1/account" })).statusCode).toBe(401);
  });

  it("с подделанным ключом отвечает 401", async () => {
    const r = await app.inject({ url: "/v1/account", headers: authHeaders("не.токен.вовсе") });
    expect(r.statusCode).toBe(401);
  });

  it("не отдаёт чужой профиль по чужому ключу", async () => {
    const other = await createAccountWithEmail("other@ya.ru");
    const otherAuth = authHeaders((await issueTestToken(other.accountId)).token);
    const r = await app.inject({ url: "/v1/account", headers: otherAuth });
    expect(r.json().email).toBe("other@ya.ru");
  });

  it("не отдаёт ни одного поля сверх объявленных в спецификации", async () => {
    const r = await app.inject({ url: "/v1/account", headers: auth });
    expect(Object.keys(r.json()).sort()).toEqual(
      ["display_name", "email", "email_verified", "id", "products"]);
  });
});

describe("PATCH /v1/account", () => {
  it("меняет имя", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/v1/account", headers: auth,
      payload: { display_name: "Илья" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().display_name).toBe("Илья");
  });

  it("пустое значение убирает имя", async () => {
    await app.inject({ method: "PATCH", url: "/v1/account", headers: auth,
      payload: { display_name: "Илья" } });
    const r = await app.inject({ method: "PATCH", url: "/v1/account", headers: auth,
      payload: { display_name: null } });
    expect(r.json().display_name).toBeNull();
  });

  it("слишком длинное имя отклоняется", async () => {
    const r = await app.inject({ method: "PATCH", url: "/v1/account", headers: auth,
      payload: { display_name: "и".repeat(101) } });
    expect(r.statusCode).toBe(400);
  });
});

describe("почты", () => {
  it("отдаёт перечень с признаком основной", async () => {
    const r = await app.inject({ url: "/v1/account/emails", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().emails).toHaveLength(1);
    expect(r.json().emails[0]).toMatchObject({ is_primary: true, verified: true });
  });

  it("добавление почты отвечает 202 и не подтверждает адрес сразу", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/account/emails", headers: auth,
      payload: { email: "second@ya.ru" },
    });
    expect(r.statusCode).toBe(202);
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const added = list.json().emails.find((e: { email: string }) => e.email === "second@ya.ru");
    expect(added.verified).toBe(false);
  });

  it("чужая почта не добавляется: 409", async () => {
    await createAccountWithEmail("taken@ya.ru");
    const r = await app.inject({
      method: "POST", url: "/v1/account/emails", headers: auth,
      payload: { email: "taken@ya.ru" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("неподтверждённая почта не становится основной", async () => {
    await app.inject({ method: "POST", url: "/v1/account/emails", headers: auth,
      payload: { email: "unv@ya.ru" } });
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const id = list.json().emails.find((e: { email: string }) => e.email === "unv@ya.ru").id;
    const r = await app.inject({
      method: "POST", url: `/v1/account/emails/${id}/primary`, headers: auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("email_not_verified");
  });

  it("подтверждённая почта становится основной, прежняя перестаёт быть", async () => {
    await getPool().query(
      `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
       VALUES ($1, 'second@ya.ru', now(), false)`, [accountId]);
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const id = list.json().emails.find((e: { email: string }) => e.email === "second@ya.ru").id;
    const r = await app.inject({
      method: "POST", url: `/v1/account/emails/${id}/primary`, headers: auth });
    expect(r.statusCode).toBe(200);
    const primaries = r.json().emails.filter((e: { is_primary: boolean }) => e.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].email).toBe("second@ya.ru");
  });

  it("чужую почту нельзя ни сделать основной, ни удалить", async () => {
    const other = await createAccountWithEmail("stranger@ya.ru");
    const { rows } = await getPool().query(
      "SELECT id FROM account_emails WHERE account_id = $1", [other.accountId]);
    const id = rows[0].id;
    expect((await app.inject({
      method: "DELETE", url: `/v1/account/emails/${id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST", url: `/v1/account/emails/${id}/primary`, headers: auth })).statusCode).toBe(404);
  });
});

describe("И-5: последняя почта не удаляется", () => {
  it("удаление единственной почты отклоняется сервером", async () => {
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const id = list.json().emails[0].id;
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/emails/${id}`, headers: auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("last_login_method");
  });

  it("дополнительная почта удаляется", async () => {
    await getPool().query(
      `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
       VALUES ($1, 'extra@ya.ru', now(), false)`, [accountId]);
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const id = list.json().emails.find((e: { email: string }) => e.email === "extra@ya.ru").id;
    expect((await app.inject({
      method: "DELETE", url: `/v1/account/emails/${id}`, headers: auth })).statusCode).toBe(204);
  });

  it("основную почту не удалить, даже если есть вторая подтверждённая", async () => {
    // «Почта — запасной способ входа. Её можно изменить, но не удалить»:
    // сначала другая становится основной, и только потом прежнюю можно убрать.
    await getPool().query(
      `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
       VALUES ($1, 'extra2@ya.ru', now(), false)`, [accountId]);
    const list = await app.inject({ url: "/v1/account/emails", headers: auth });
    const primary = list.json().emails.find((e: { is_primary: boolean }) => e.is_primary);
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/emails/${primary.id}`, headers: auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("primary_email");
  });
});
