import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import {
  registerNativeAdapter, clearNativeAdapters, type NativeAdapter,
} from "../src/services/providers/native.js";

/**
 * У КАЖДОГО выхода маршрута есть запись в журнале.
 *
 * Это не придирка к полноте, а исправление дефекта, который стоил
 * агенту ПРАКТИКИ двух суток разбора (issue #27, 12.09.2026).
 *
 * Нативный вход ВК отказывал на `422 email_required` — единственном
 * исходе маршрута, который не оставлял следа вообще. Осмотр сервера
 * честно показывал «записей с provider = vkid нет», мы честно читали
 * это как «запрос до нас не дошёл» и трижды отправляли их проверять
 * устройство, где всё было в порядке. Вывод был неверный, а данные —
 * верные: молчал не сервис, молчал маршрут.
 *
 * Свойство, которое обязано держаться: **ноль записей означает ровно
 * одно — запрос не пришёл.** Оно ломается от одного молчащего выхода,
 * поэтому проверяются все, а не только тот, на котором обожглись.
 *
 * Причина отказа живёт в ИМЕНИ события: колонки под причину в
 * audit_log нет и не будет — она собирала бы подробности о человеке.
 */

let app: FastifyInstance;
const FIRST_PARTY = { "x-client-id": "practice-mobile" };
const URL_NATIVE = "/v1/auth/provider/yandex/native";
const ok = { provider_code: "c-1", device_key: "d", platform: "android" };

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
beforeEach(async () => { await resetData(); clearNativeAdapters(); });
afterAll(async () => { clearNativeAdapters(); await app.close(); await closePool(); });

function adapter(exchange: NativeAdapter["exchange"]): void {
  registerNativeAdapter({ provider: "yandex", exchange });
}
function identity(email: string | null, emailVerified = email !== null) {
  return vi.fn(async () => ({ subject: "y-1", email, emailVerified }));
}

/** Что журнал запомнил: событие, провайдер, исход. Без ПДн. */
async function journal(): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT event, coalesce(provider,'—') AS provider, outcome
     FROM audit_log ORDER BY at, event`,
  );
  return rows.map((r) => `${r.event} ${r.provider} ${r.outcome}`);
}

describe("нативный вход: ни один выход не молчит", () => {
  it("тело без кода и без JWT оставляет запись", async () => {
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: { device_key: "d", platform: "android" } });
    expect(r.statusCode).toBe(400);
    expect(await journal()).toEqual(["provider_native_bad_request yandex fail"]);
  });

  it("провайдер без подключённого SDK оставляет запись", async () => {
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("provider_unavailable");
    expect(await journal()).toEqual(["provider_unavailable yandex fail"]);
  });

  it("отказ обмена оставляет запись", async () => {
    adapter(async () => { throw new Error("нет"); });
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(400);
    expect(await journal()).toEqual(["provider_exchange yandex fail"]);
  });

  it("профиль без почты оставляет запись — тот самый случай ВК", async () => {
    // ВК на нативном входе отдаёт профиль без адреса, если приложение
    // не запросило область доступа `email` само: в браузерном входе её
    // ставим мы, в нативном авторизацию начинает приложение.
    adapter(identity(null));
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("email_required");
    expect(await journal()).toEqual(["provider_email_required yandex fail"]);
  });

  it("неподтверждённая почта оставляет запись", async () => {
    adapter(identity("unv@ya.ru", false));
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(422);
    expect(await journal()).toEqual(["provider_email_required yandex fail"]);
  });

  it("занятый субъект провайдера оставляет запись", async () => {
    const other = await createAccountWithEmail("owner@ya.ru");
    await getPool().query(
      `INSERT INTO identities (account_id, provider, subject) VALUES ($1,'yandex','y-1')`,
      [other.accountId]);
    adapter(identity("a@ya.ru"));
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(409);
    expect(await journal()).toEqual(["provider_login yandex fail"]);
  });

  it("удавшийся вход оставляет запись", async () => {
    adapter(identity("new@ya.ru"));
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: FIRST_PARTY, payload: ok });
    expect(r.statusCode).toBe(200);
    expect(await journal()).toEqual(["login_provider_native yandex ok"]);
  });

  it("клиент без first_party не доходит до маршрута и оставляет свою запись", async () => {
    const r = await app.inject({ method: "POST", url: URL_NATIVE,
      headers: { "x-client-id": "test" }, payload: ok });
    expect(r.statusCode).toBe(403);
    expect(await journal()).toEqual(["first_party_denied — fail"]);
  });
});

describe("сторож: новый выход маршрута не уедет без записи", () => {
  it("выходов у нативного маршрута ровно столько, сколько случаев выше", async () => {
    // Проверка от забывчивости, а не от злого умысла. Случаи выше
    // перечислены руками, и через месяц в маршрут добавят седьмой
    // выход, которого в этой таблице не будет. Тогда красный тест
    // скажет: завели новый выход — заведите ему и запись в журнале,
    // и случай здесь. Молча это больше не пройдёт.
    const src = readFileSync(new URL("../src/api/v1/auth.ts", import.meta.url), "utf8");
    const начало = src.indexOf('"/v1/auth/provider/:provider/native"');
    const конец = src.indexOf('app.post("/v1/auth/token/refresh"');
    expect(начало).toBeGreaterThan(0);
    expect(конец).toBeGreaterThan(начало);
    const handler = src.slice(начало, конец);
    const выходов = handler.match(/reply\s*\n?\s*\.?\s*(?:code\([^)]*\)\s*\.)?send\(/g) ?? [];
    expect(выходов).toHaveLength(6);
  });
});

describe("соседние маршруты: испорченное тело тоже оставляет след", () => {
  it("почта: запрос кода с испорченным телом", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/email/start",
      headers: FIRST_PARTY, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(await journal()).toEqual(["email_start — fail"]);
  });

  it("почта: проверка кода с испорченным телом", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/email/verify",
      headers: FIRST_PARTY, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(await journal()).toEqual(["email_verify — fail"]);
  });

  it("ротация с испорченным телом", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/token/refresh",
      headers: FIRST_PARTY, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(await journal()).toEqual(["token_refresh — fail"]);
  });
});
