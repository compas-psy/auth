import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { writeAudit } from "../src/services/audit.js";
import { recentEvents } from "../src/services/incidents.js";

/**
 * Свод событий для разбора «вход не работает».
 *
 * У каждой ветки отказа во входе через внешний сервис своё событие:
 * provider_state, provider_exchange, provider_login. По тому, какое
 * записано последним, видно, ДОКУДА дошёл человек, — а это и есть
 * ответ на вопрос, что чинить.
 *
 * Читается свод, а не строки: строка журнала привязана к учётной
 * записи, а разбирающему нужна картина, а не чей-то конкретный вход.
 */

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("свод событий", () => {
  it("считает события по виду, провайдеру и исходу", async () => {
    await writeAudit({ event: "provider_start", provider: "yandex", outcome: "ok" });
    await writeAudit({ event: "provider_start", provider: "yandex", outcome: "ok" });
    await writeAudit({ event: "provider_exchange", provider: "yandex", outcome: "fail" });

    const rows = await recentEvents(6);
    expect(rows).toContainEqual(
      { event: "provider_start", provider: "yandex", outcome: "ok", count: 2 });
    expect(rows).toContainEqual(
      { event: "provider_exchange", provider: "yandex", outcome: "fail", count: 1 });
  });

  it("старое за окно не попадает", async () => {
    await writeAudit({ event: "login_provider", provider: "yandex", outcome: "ok" });
    await getPool().query("UPDATE audit_log SET at = now() - interval '9 hours'");
    expect(await recentEvents(6)).toEqual([]);
  });

  it("не выносит наружу ни учётных записей, ни хешей", async () => {
    // Свод печатается в журнал прогона. Даже ip_hash здесь лишний:
    // вопрос «что сломалось», а не «кто приходил».
    const { accountId } = await createAccountWithEmail("who@ya.ru");
    await writeAudit({
      accountId, event: "login_provider", provider: "yandex",
      outcome: "ok", ip: "203.0.113.1", ua: "Mozilla/5.0",
    });
    const dump = JSON.stringify(await recentEvents(6));
    expect(dump).not.toContain(accountId);
    expect(dump).not.toContain("hash");
    expect(dump).not.toMatch(/[0-9a-f]{32}/);
  });

  it("пустой свод отличим от несобранного", async () => {
    // Пустой массив — это «событий не было», и вызывающий обязан
    // сказать это словами, а не напечатать пустоту.
    expect(await recentEvents(6)).toEqual([]);
  });
});
