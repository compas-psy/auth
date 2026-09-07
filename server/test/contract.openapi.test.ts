import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken, authHeaders } from "./helpers.js";
import { createAccountWithEmail, PRODUCTS } from "../src/services/accounts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(HERE, "../openapi/simpasid.v1.yaml");
const spec = parse(readFileSync(SPEC_PATH, "utf8"));

let app: FastifyInstance;
let auth: Record<string, string>;
let accountId: string;

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  app = await buildServer();
  await app.ready();
  ({ accountId } = await createAccountWithEmail("contract@ya.ru"));
  auth = authHeaders((await issueTestToken(accountId)).token);
});
afterAll(async () => { await app.close(); await closePool(); });

/**
 * Схемы проверяются вместе со всем разделом components: внутри них
 * стоят $ref друг на друга, и в отрыве они не компилируются.
 */
function validatorFor(schemaName: string) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: "spec", components: spec.components });
  return ajv.compile({
    $ref: `spec#/components/schemas/${schemaName}`,
  });
}

function check(schemaName: string, body: unknown): void {
  const validate = validatorFor(schemaName);
  const ok = validate(body);
  if (!ok) {
    throw new Error(
      `ответ не соответствует схеме ${schemaName}: ${JSON.stringify(validate.errors)}`,
    );
  }
  expect(ok).toBe(true);
}

describe("реализация соответствует спецификации", () => {
  it("ответ GET /v1/account валиден по схеме Account", async () => {
    const r = await app.inject({ url: "/v1/account", headers: auth });
    expect(r.statusCode).toBe(200);
    check("Account", r.json());
  });

  it("ответ GET /v1/account/emails валиден по схеме EmailList", async () => {
    const r = await app.inject({ url: "/v1/account/emails", headers: auth });
    check("EmailList", r.json());
  });

  it("ответ GET /v1/account/identities валиден по схеме IdentityList", async () => {
    const r = await app.inject({ url: "/v1/account/identities", headers: auth });
    check("IdentityList", r.json());
  });

  it("ответ GET /v1/account/sessions валиден по схеме SessionList", async () => {
    const r = await app.inject({ url: "/v1/account/sessions", headers: auth });
    check("SessionList", r.json());
  });

  it("ответ GET /v1/account/consents валиден по схеме ConsentsState", async () => {
    const r = await app.inject({ url: "/v1/account/consents", headers: auth });
    check("ConsentsState", r.json());
  });

  it("ответ GET /v1/account/audit валиден по схеме AuditList", async () => {
    const r = await app.inject({ url: "/v1/account/audit", headers: auth });
    check("AuditList", r.json());
  });

  it("ответ GET /v1/auth/methods валиден по схеме AuthMethods", async () => {
    const r = await app.inject({
      url: "/v1/auth/methods", headers: { "x-client-id": "practice-mobile" } });
    check("AuthMethods", r.json());
  });

  it("отказ отдаётся по схеме Error", async () => {
    const r = await app.inject({ url: "/v1/account" });
    expect(r.statusCode).toBe(401);
    check("Error", r.json());
  });

  it("каждый объявленный в спецификации путь существует у сервера", async () => {
    // Обратная проверка: спецификация не должна обещать ручку, которой нет.
    const declared = Object.keys(spec.paths).map((p: string) => `/v1${p}`);
    const routes = app.printRoutes({ commonPrefix: false });
    const missing = declared.filter((p) => {
      const pattern = p.replace(/\{[^}]+\}/g, ":");
      const literal = pattern.split("/:")[0]!;
      return !routes.includes(literal.replace(/^\//, ""))
        && !routes.includes(literal.split("/").pop() ?? "");
    });
    expect(missing).toEqual([]);
  });

  it("ни одна ручка /v1 не отдаёт поля, которых нет в спецификации", async () => {
    const cases: Array<[string, string]> = [
      ["/v1/account", "Account"],
      ["/v1/account/emails", "EmailList"],
      ["/v1/account/identities", "IdentityList"],
      ["/v1/account/sessions", "SessionList"],
      ["/v1/account/consents", "ConsentsState"],
      ["/v1/account/audit", "AuditList"],
    ];
    for (const [url, schemaName] of cases) {
      const r = await app.inject({ url, headers: auth });
      const schema = spec.components.schemas[schemaName];
      const allowed = new Set(Object.keys(schema.properties));
      const extra = Object.keys(r.json()).filter((k) => !allowed.has(k));
      expect({ url, extra }).toEqual({ url, extra: [] });
    }
  });

  it("в спецификации нет запрещённых И-2 полей", () => {
    const dump = JSON.stringify(spec.components.schemas);
    for (const forbidden of ["\"phone\"", "\"otp\"", "\"sms_code\"", "\"password\""]) {
      expect(dump).not.toContain(forbidden);
    }
  });

  /**
   * Первичный токен-API открыт ТОЛЬКО клиентам с first_party = true, и
   * заголовок X-Client-Id — единственное, чем клиент себя называет.
   * Пока спецификация об этом молчит, чужой разработчик пишет клиента
   * без заголовка, получает 403 и не понимает, почему: справочник
   * ресурса разработчика ГЕНЕРИРУЕТСЯ отсюда, другого источника у него
   * нет. Это не украшение спецификации, а работоспособность рецепта.
   */
  it("каждая ручка /v1/auth требует заголовок X-Client-Id по спецификации", () => {
    const scheme = spec.components.securitySchemes.firstPartyClient;
    expect(scheme).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-Client-Id",
      description: expect.any(String),
    });

    const authPaths = Object.entries(spec.paths as Record<string, Record<string, {
      security?: Array<Record<string, unknown>>;
      responses?: Record<string, unknown>;
    }>>).filter(([path]) => path.startsWith("/auth/"));
    expect(authPaths.length).toBeGreaterThan(0);

    for (const [path, methods] of authPaths) {
      for (const [method, op] of Object.entries(methods)) {
        const names = (op.security ?? []).flatMap((s) => Object.keys(s));
        expect({ path, method, names }).toEqual(
          { path, method, names: ["firstPartyClient"] });
        // Отказ чужому клиенту тоже объявлен: иначе рецепт не
        // объясняет, что означает 403 и что с ним делать.
        expect({ path, method, has403: "403" in (op.responses ?? {}) })
          .toEqual({ path, method, has403: true });
      }
    }
  });

  it("сервер и вправду отвергает /v1/auth без X-Client-Id", async () => {
    // Спецификация может обещать что угодно; проверяется поведение.
    for (const url of ["/v1/auth/methods", "/v1/auth/email/start"]) {
      const r = await app.inject({ method: "POST", url, payload: {} });
      expect({ url, code: r.statusCode }).toEqual({ url, code: 403 });
      expect(r.json()).toEqual({ error: "forbidden_client" });
    }
  });

  /**
   * Перечень продуктов растёт: сегодня добавились ШАГИ, и они вряд ли
   * последние. Значение, дописанное в закрытый enum ОТВЕТА, — ломающее
   * изменение контракта: клиент, написанный по прежней спецификации,
   * такого продукта не ждёт. x-extensible-enum говорит честно: набор
   * будет расти, неизвестное значение обязано быть обработано.
   *
   * В запросах ProductCode не используется ни разу, так что строгость
   * приёма от этого не теряется — её держат перечень в коде и
   * ограничение схемы в базе.
   */
  it("перечень продуктов объявлен растущим и совпадает с кодом", () => {
    const schema = spec.components.schemas.ProductCode;
    expect(schema.enum, "закрытый enum ломает клиентов при добавлении продукта")
      .toBeUndefined();
    expect([...schema["x-extensible-enum"]].sort()).toEqual([...PRODUCTS].sort());
  });

  it("адрес сервера — auth.cmpas.ru, а не устаревший api.simpas.ru", () => {
    expect(spec.servers[0].url).toBe("https://auth.cmpas.ru/v1");
    expect(JSON.stringify(spec)).not.toContain("api.simpas.ru");
  });
});
