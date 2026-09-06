import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import {
  registerNativeAdapter, clearNativeAdapters, availableProviders,
  type NativeAdapter,
} from "../src/services/providers/native.js";

let app: FastifyInstance;
const FIRST_PARTY = { "x-client-id": "practice-mobile" };
const body = { provider_code: "abc", device_key: "d", platform: "android" };

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => { await resetData(); clearNativeAdapters(); });
afterAll(async () => { clearNativeAdapters(); await app.close(); await closePool(); });

function mockProvider(result: { id: string; email: string | null; emailVerified?: boolean }) {
  const exchange = vi.fn(async () => ({
    subject: result.id,
    email: result.email,
    emailVerified: result.emailVerified ?? result.email !== null,
  }));
  const adapter: NativeAdapter = { provider: "yandex", exchange };
  registerNativeAdapter(adapter);
  return exchange;
}

describe("нативный обмен кода провайдера", () => {
  it("код проверяется на сервере провайдера, а не принимается на слово", async () => {
    const spy = mockProvider({ id: "y-1", email: "y1@ya.ru" });
    await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(spy).toHaveBeenCalled();
  });

  it("провайдер без подтверждённой почты даёт 422 email_required", async () => {
    mockProvider({ id: "y-1", email: null });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("email_required");
  });

  it("неподтверждённая провайдером почта тоже даёт 422", async () => {
    // И-5 требует ПОДТВЕРЖДЁННОЙ почты. Слово провайдера «адрес такой»
    // без признака подтверждения этого не даёт.
    mockProvider({ id: "y-2", email: "unv@ya.ru", emailVerified: false });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("email_required");
  });

  it("занятый субъект провайдера даёт 409", async () => {
    const other = await createAccountWithEmail("owner@ya.ru");
    await getPool().query(
      `INSERT INTO identities (account_id, provider, subject) VALUES ($1,'yandex','taken')`,
      [other.accountId]);
    mockProvider({ id: "taken", email: "a@ya.ru" });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("identity_taken");
  });

  it("первый вход заводит запись, привязку и выдаёт токены", async () => {
    mockProvider({ id: "y-new", email: "new@ya.ru" });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json().access_token).toBeTruthy();
    expect(r.json().account.email).toBe("new@ya.ru");
    const { rows } = await getPool().query(
      "SELECT provider, subject FROM identities");
    expect(rows[0]).toMatchObject({ provider: "yandex", subject: "y-new" });
  });

  it("повторный вход попадает в ту же учётную запись", async () => {
    mockProvider({ id: "y-same", email: "same@ya.ru" });
    const first = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(second.json().account.id).toBe(first.json().account.id);
  });

  it("существующая почта связывается с той же личностью, а не заводит вторую", async () => {
    const existing = await createAccountWithEmail("known@ya.ru");
    mockProvider({ id: "y-link", email: "known@ya.ru" });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.json().account.id).toBe(existing.accountId);
  });

  it("токены провайдера после обмена не сохраняются", async () => {
    mockProvider({ id: "y-tok", email: "tok@ya.ru" });
    await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: FIRST_PARTY, payload: body });
    const { rows } = await getPool().query("SELECT * FROM identities");
    expect(JSON.stringify(rows)).not.toContain("abc");
  });

  it("провайдер без подключённого SDK не обслуживается вовсе", async () => {
    // Ни один SDK не подключён: адаптеров нет.
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/sberid/native",
      headers: FIRST_PARTY, payload: body });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("provider_unavailable");
  });

  it("сторонний клиент к нативному обмену не допускается", async () => {
    mockProvider({ id: "y-1", email: "y@ya.ru" });
    const r = await app.inject({ method: "POST", url: "/v1/auth/provider/yandex/native",
      headers: { "x-client-id": "test" }, payload: body });
    expect(r.statusCode).toBe(403);
  });

  it("методы входа на мобильной платформе не включают провайдера без SDK", async () => {
    const r = await app.inject({ url: "/v1/auth/methods?platform=android", headers: FIRST_PARTY });
    expect(r.json().providers).not.toContain("sberid");
  });

  it("подключённый SDK появляется в методах входа на мобильной платформе", async () => {
    mockProvider({ id: "y", email: "y@ya.ru" });
    expect(await availableProviders("android")).toContain("yandex");
    // На вебе нативный SDK ничего не значит: там OIDC с редиректом,
    // и провайдер появляется только после подключения по Э5.
    expect(await availableProviders("web")).not.toContain("yandex");
  });
});
