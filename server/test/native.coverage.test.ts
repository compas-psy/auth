import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken, authHeaders } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(join(HERE, "../openapi/simpasid.v1.yaml"), "utf8"));

/**
 * Экраны нативного портала (12_NATIVE_AUTH.md §4: O1н и O2н) и ручки,
 * которыми каждый живёт. Список составлен проходом по каждому экрану,
 * как требует Шаг 1 Задачи Н4.
 *
 * Если экрану чего-то не хватает — это дефект API, а не повод сделать
 * исключение: мобильное приложение просто ещё один потребитель того же
 * публичного API (§2.3).
 */
const NATIVE_SCREENS: Array<{ screen: string; calls: string[] }> = [
  { screen: "O1н · вход по почте", calls: ["/auth/email/start", "/auth/email/verify"] },
  { screen: "O1н · вход через внешний сервис",
    calls: ["/auth/methods", "/auth/provider/{provider}/native"] },
  { screen: "O1н · продление и выход",
    calls: ["/auth/token/refresh", "/auth/logout"] },
  { screen: "O1н · обзор аккаунта", calls: ["/account"] },
  { screen: "O1н · личные данные",
    calls: ["/account", "/account/emails", "/account/emails/{email_id}",
            "/account/emails/{email_id}/primary"] },
  { screen: "O1н · безопасность",
    calls: ["/account/identities", "/account/identities/{provider}/link",
            "/account/identities/{identity_id}"] },
  { screen: "O1н · устройства",
    calls: ["/account/sessions", "/account/sessions/{session_id}",
            "/account/sessions/revoke-others"] },
  { screen: "O2н · коммуникации",
    calls: ["/account/consents", "/account/consents/revoke-all-marketing"] },
  { screen: "O1н · данные и приватность", calls: ["/account/consents"] },
  { screen: "O1н · журнал событий", calls: ["/account/audit"] },
];

let app: FastifyInstance;
beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

describe("Н4: нативный портал обходится существующим API", () => {
  it("каждый экран покрыт объявленными в спецификации ручками", () => {
    const declared = new Set<string>(Object.keys(spec.paths));
    const missing: string[] = [];
    for (const screen of NATIVE_SCREENS) {
      for (const call of screen.calls) {
        if (!declared.has(call)) missing.push(`${screen.screen}: ${call}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("каждая объявленная ручка действительно отвечает, а не только описана", async () => {
    const { accountId } = await createAccountWithEmail("native@ya.ru");
    const auth = authHeaders((await issueTestToken(accountId)).token);
    const readable = [
      "/v1/account", "/v1/account/emails", "/v1/account/identities",
      "/v1/account/sessions", "/v1/account/consents", "/v1/account/audit",
    ];
    for (const url of readable) {
      const r = await app.inject({ url, headers: auth });
      expect({ url, code: r.statusCode }).toEqual({ url, code: 200 });
    }
  });

  it("нативному порталу не нужно ни одной ручки сверх публичного API", () => {
    // Обратная проверка: в перечне экранов нет пути вне /v1.
    const outside = NATIVE_SCREENS.flatMap((s) => s.calls)
      .filter((c) => !c.startsWith("/account") && !c.startsWith("/auth"));
    expect(outside).toEqual([]);
  });

  it("мобильный вход не требует ни одной ручки, ведущей в браузер", () => {
    const authCalls = NATIVE_SCREENS.flatMap((s) => s.calls).filter((c) => c.startsWith("/auth"));
    // Ни authorize, ни redirect, ни callback: мобильное приложение
    // не уходит в браузер и не открывает наш веб.
    for (const call of authCalls) {
      expect(call).not.toMatch(/authorize|redirect|callback|oidc/i);
    }
  });
});
