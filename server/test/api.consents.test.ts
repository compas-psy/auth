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
  ({ accountId } = await createAccountWithEmail("cons@ya.ru"));
  auth = authHeaders((await issueTestToken(accountId)).token);
});
afterAll(async () => { await app.close(); await closePool(); });

const grantEmail = {
  document_code: "cmpas_marketing_consent", version: "0.9",
  channel: "email", status: "granted", action: "switch_marketing_email",
};

describe("Т10: рекламное согласие", () => {
  it("по умолчанию все каналы выключены", async () => {
    const r = await app.inject({ url: "/v1/account/consents", headers: auth });
    const marketing = r.json().communications;
    expect(marketing.length).toBeGreaterThan(0);
    expect(marketing.every((c: { status: string }) => c.status === "revoked")).toBe(true);
  });

  it("включение одного канала не включает другие", async () => {
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: grantEmail });
    const r = await app.inject({ url: "/v1/account/consents", headers: auth });
    const byChannel = Object.fromEntries(
      r.json().communications.map((c: { channel: string; status: string }) => [c.channel, c.status]));
    expect(byChannel.email).toBe("granted");
    expect(byChannel.push).toBe("revoked");
  });

  it("«отключить всю рекламу» отзывает все активные каналы", async () => {
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: grantEmail });
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { ...grantEmail, channel: "push", action: "switch_marketing_push" } });
    await app.inject({ method: "POST",
      url: "/v1/account/consents/revoke-all-marketing", headers: auth });
    const r = await app.inject({ url: "/v1/account/consents", headers: auth });
    expect(r.json().communications.every(
      (c: { status: string }) => c.status === "revoked")).toBe(true);
  });

  it("отзыв не удаляет историю", async () => {
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: grantEmail });
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { ...grantEmail, status: "revoked" } });
    const { rows } = await getPool().query(
      "SELECT count(*)::int n FROM consent_events WHERE account_id = $1", [accountId]);
    expect(rows[0].n).toBeGreaterThan(1);
  });

  it("SMS как канал не существует", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { ...grantEmail, channel: "sms" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("unknown_channel");
  });

  it("Политику принять нельзя: это информационный документ", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { document_code: "cmpas_privacy", version: "0.9",
                 status: "granted", action: "accept_privacy" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("document_is_informational");
  });

  it("согласие на устаревшую редакцию отклоняется", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { ...grantEmail, version: "0.1" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("stale_document_version");
  });

  it("принятые документы отдаются с редакцией и ссылкой на неё", async () => {
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { document_code: "cmpas_practice_terms", version: "0.9",
                 status: "granted", action: "start_practice" } });
    const r = await app.inject({ url: "/v1/account/consents", headers: auth });
    const doc = r.json().accepted_documents.find(
      (d: { document_code: string }) => d.document_code === "cmpas_practice_terms");
    expect(doc.version).toBe("0.9");
    expect(doc.url).toBe("/legal/practice-terms/0.9");
    expect(doc.title).toBe("Особые условия ПРАКТИКИ");
  });

  it("«отключить всю рекламу» доступно всегда, даже когда всё уже выключено", async () => {
    const r = await app.inject({ method: "POST",
      url: "/v1/account/consents/revoke-all-marketing", headers: auth });
    expect(r.statusCode).toBe(200);
  });

  it("чужое согласие не изменить: аккаунт берётся из ключа, не из тела", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: { ...grantEmail, account_id: "00000000-0000-0000-0000-000000000000" } });
    expect(r.statusCode).toBe(200);
    const { rows } = await getPool().query(
      "SELECT DISTINCT account_id FROM consent_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(accountId);
  });
});

describe("устройства и сеансы", () => {
  it("отдаёт огрублённые платформу и клиента, помечая текущий сеанс", async () => {
    const { token, sessionId } = await issueTestToken(accountId, {
      platform: "windows", client: "chrome" });
    const r = await app.inject({ url: "/v1/account/sessions", headers: authHeaders(token) });
    const current = r.json().sessions.find((s: { id: string }) => s.id === sessionId);
    expect(current).toMatchObject({ current: true, platform: "windows", client: "chrome" });
  });

  it("не отдаёт ни IP-адреса, ни user-agent", async () => {
    const r = await app.inject({ url: "/v1/account/sessions", headers: auth });
    const dump = JSON.stringify(r.json());
    expect(dump).not.toContain("ip");
    expect(dump).not.toContain("user_agent");
    expect(Object.keys(r.json().sessions[0]).sort())
      .toEqual(["client", "current", "id", "last_seen_at", "platform"]);
  });

  it("завершённый сеанс исчезает из перечня", async () => {
    const { sessionId } = await issueTestToken(accountId, { deviceKey: "second" });
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/sessions/${sessionId}`, headers: auth });
    expect(r.statusCode).toBe(204);
    const list = await app.inject({ url: "/v1/account/sessions", headers: auth });
    expect(list.json().sessions.find((s: { id: string }) => s.id === sessionId)).toBeUndefined();
  });

  it("чужой сеанс не завершить", async () => {
    const other = await createAccountWithEmail("victim2@ya.ru");
    const { sessionId } = await issueTestToken(other.accountId);
    const r = await app.inject({
      method: "DELETE", url: `/v1/account/sessions/${sessionId}`, headers: auth });
    expect(r.statusCode).toBe(404);
  });

  it("«выйти на всех, кроме этого» оставляет текущий", async () => {
    const me = await issueTestToken(accountId, { deviceKey: "mine" });
    await issueTestToken(accountId, { deviceKey: "other-1" });
    await issueTestToken(accountId, { deviceKey: "other-2" });
    const r = await app.inject({ method: "POST",
      url: "/v1/account/sessions/revoke-others", headers: authHeaders(me.token) });
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBeGreaterThanOrEqual(2);
    const list = await app.inject({ url: "/v1/account/sessions", headers: authHeaders(me.token) });
    expect(list.json().sessions).toHaveLength(1);
    expect(list.json().sessions[0].id).toBe(me.sessionId);
  });
});

describe("журнал событий человека", () => {
  it("отдаёт события без ПДн", async () => {
    await app.inject({ method: "PUT", url: "/v1/account/consents", headers: auth,
      payload: grantEmail });
    const r = await app.inject({ url: "/v1/account/audit", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().events.length).toBeGreaterThan(0);
    const dump = JSON.stringify(r.json());
    expect(dump).not.toContain("cons@ya.ru");
    expect(dump).not.toContain(accountId);
  });

  it("слишком большой limit отклоняется", async () => {
    const r = await app.inject({ url: "/v1/account/audit?limit=100000", headers: auth });
    expect(r.statusCode).toBe(400);
  });
});
