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
import { createAccountWithEmail } from "../src/services/accounts.js";

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

  it("адрес сервера — auth.cmpas.ru, а не устаревший api.simpas.ru", () => {
    expect(spec.servers[0].url).toBe("https://auth.cmpas.ru/v1");
    expect(JSON.stringify(spec)).not.toContain("api.simpas.ru");
  });
});
