import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { PostgresAdapter } from "../src/oidc/adapter.js";
import { createClient } from "../src/oidc/clients.js";

/**
 * Реестр клиентов — источник истины В МОМЕНТ ЗАПРОСА, а не в момент запуска.
 *
 * Портал аккаунта не открывался у живого человека именно из-за этого:
 * клиент account-portal был заведён после выкладки, а провайдер держал
 * перечень клиентов, прочитанный один раз при старте, и отвечал
 * invalid_client. Заведение клиента, которое «сработает после
 * перезапуска», — это ручное действие учредителя (нарушение Р-3),
 * спрятанное за словом «выложить».
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const LATE = "late-client";
const LATE_REDIRECT = "https://late.example.test/cb";

function authUrl(clientId: string, redirect: string): string {
  return "/oidc/auth?" + new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirect,
    scope: "openid email",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "st", nonce: "nc",
  });
}

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  await getPool().query("DELETE FROM oidc_clients WHERE client_id = $1", [LATE]);
  // Сервер собирается ДО заведения клиента — как в бою, где выкладка
  // произошла раньше регистрации.
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await getPool().query("DELETE FROM oidc_clients WHERE client_id = $1", [LATE]);
  if (app) await app.close();
  await closePool();
});

describe("клиент, заведённый после запуска", () => {
  it("принимается без перезапуска сервиса", async () => {
    await createClient({
      clientId: LATE,
      clientName: "Поздний клиент",
      redirectUris: [LATE_REDIRECT],
      isPublic: true,
    });

    const r = await app.inject({ url: authUrl(LATE, LATE_REDIRECT), headers: HOST });

    // Ровно та ошибка, которую видел человек на auth.cmpas.ru.
    expect(r.body).not.toContain("invalid_client");
    expect(String(r.headers.location)).toMatch(/^\/interaction\//);
  });

  it("отключённый клиент перестаёт приниматься тоже без перезапуска", async () => {
    await getPool().query(
      "UPDATE oidc_clients SET disabled_at = now() WHERE client_id = $1",
      [LATE],
    );
    const r = await app.inject({ url: authUrl(LATE, LATE_REDIRECT), headers: HOST });
    expect(String(r.headers.location ?? "")).not.toMatch(/^\/interaction\//);
    await getPool().query(
      "UPDATE oidc_clients SET disabled_at = NULL WHERE client_id = $1",
      [LATE],
    );
  });
});

describe("адаптер типа Client", () => {
  it("берёт метаданные из реестра, а не из хранилища протокола", async () => {
    const found = await new PostgresAdapter("Client").find("test");
    expect(found?.client_id).toBe("test");
    expect(found?.redirect_uris).toEqual(["https://ex.test/cb"]);
    // Публичный клиент обязан приходить без ключа, а не с null:
    // null в метаданных библиотека считает заданным значением.
    const mobile = await new PostgresAdapter("Client").find("practice-mobile");
    expect(mobile).toBeDefined();
    expect("client_secret" in mobile!).toBe(false);
  });

  it("неизвестный клиент — undefined, а не пустой объект", async () => {
    expect(await new PostgresAdapter("Client").find("нет-такого")).toBeUndefined();
  });
});
