import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import {
  clearWebProviders, registerWebProvider,
} from "../src/services/providers/registry.js";

/**
 * Акцепт Пользовательского соглашения при входе через провайдера.
 *
 * Человек видит юридическую строку на нашем экране и нажимает кнопку
 * провайдера — это и есть акцепт действием. Записи об этом не
 * возникало: recordConsent в контуре взаимодействия не вызывался ни
 * разу, и вошедшие через Яндекс юридически ничего не принимали.
 *
 * Вход по почте акцепт писал (magicLink), вход через провайдера — нет.
 * Найдено 11.09.2026 при разборе просьбы агента ПРАКТИКИ.
 */
let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };
const AUTH = "/oidc/auth?" + new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

/** Провайдер-обманка: возвращает личность, к нему самому не ходим. */
const FAKE = {
  provider: "yandex" as const,
  authorizationUrl: (state: string) => `https://provider.test/auth?state=${state}`,
  exchange: async () => ({
    subject: "provider-subject-1", email: "novichok@ya.ru", emailVerified: true,
  }),
};

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  const { buildServer } = await import("../src/index.js");
  app = await buildServer();
  await app.ready();
  clearWebProviders();
  registerWebProvider(FAKE);
});
afterAll(async () => { clearWebProviders(); await app.close(); await closePool(); });

async function signInThroughProvider(): Promise<void> {
  const start = await app.inject({ url: AUTH, headers: HOST });
  const raw = start.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [String(raw ?? "")])
    .map((c) => c.split(";")[0]).join("; ");
  const uid = String(start.headers.location).replace("/interaction/", "");

  const screen = await app.inject({
    url: `/interaction/${uid}`, headers: { ...HOST, cookie } });
  const state = JSON.parse(
    /<script id="state" type="application\/json">(.*?)<\/script>/s
      .exec(screen.body)![1]!.replace(/\\u003c/g, "<"));

  // Ровно то, что делает экран: уводит к провайдеру, называя редакцию,
  // которую человек на нём видел.
  const away = await app.inject({
    url: `/interaction/${uid}/provider/yandex?terms=${state.termsVersion}`,
    headers: { ...HOST, cookie },
  });
  const providerState = new URL(String(away.headers.location)).searchParams.get("state")!;

  await app.inject({
    url: `/callback/yandex?code=c&state=${encodeURIComponent(providerState)}`,
    headers: { ...HOST, cookie },
  });
}

describe("вход через провайдера фиксирует акцепт соглашения", () => {
  it("у новой учётной записи появляется запись о принятии", async () => {
    await signInThroughProvider();
    const { rows } = await getPool().query<{
      document_code: string; document_version: string; content_hash: string; action: string;
    }>(`SELECT ce.document_code, ce.document_version, ce.content_hash, ce.action
        FROM consent_events ce
        JOIN identities i ON i.account_id = ce.account_id
        WHERE i.subject = 'provider-subject-1'`);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      document_code: "cmpas_terms",
      document_version: "0.9",
      action: "signin_button",
    });
  });

  it("отпечаток записан тот же, что у опубликованной редакции", async () => {
    // Доказательство согласия — связка «редакция + отпечаток текста,
    // который человек видел». Записать сюда что угодно значит записать
    // ничего.
    const { rows } = await getPool().query<{ same: boolean }>(
      `SELECT ce.content_hash = v.content_hash AS same
       FROM consent_events ce
       JOIN legal_document_versions v
         ON v.code = ce.document_code AND v.version = ce.document_version
       JOIN identities i ON i.account_id = ce.account_id
       WHERE i.subject = 'provider-subject-1'`);
    expect(rows[0]?.same).toBe(true);
  });

  it("повторный вход того же человека второй записи не создаёт", async () => {
    // Принятие фиксируется один раз — при создании учётной записи.
    // Запись на каждый вход превратила бы журнал согласий в журнал
    // посещений.
    await signInThroughProvider();
    const { rows } = await getPool().query(
      `SELECT 1 FROM consent_events ce
       JOIN identities i ON i.account_id = ce.account_id
       WHERE i.subject = 'provider-subject-1'`);
    expect(rows.length).toBe(1);
  });
});
