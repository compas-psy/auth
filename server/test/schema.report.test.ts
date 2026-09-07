import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { schemaReport } from "../src/services/schemaReport.js";

/**
 * Осмотр обязан ПОКАЗЫВАТЬ состояние схемы, а не позволять о нём
 * догадываться.
 *
 * До этой правки применённость миграции на боевом сервере выводилась
 * из устройства запуска: listen происходит только после runMigrations,
 * значит отвечающий сервис миграции применил. Вывод верный, но это
 * вывод, а не наблюдение. Обязательство перед ПРАКТИКОЙ («sub не
 * меняется») держится на триггере, и увидеть его наличие надо глазами.
 */

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("осмотр схемы", () => {
  it("перечисляет применённые миграции по именам", async () => {
    const report = await schemaReport();
    expect(report.migrations).toContain("0001_identity.sql");
    expect(report.migrations).toContain("0012_sub_immutable.sql");
  });

  it("миграции идут по порядку — дыра в нумерации видна", async () => {
    const report = await schemaReport();
    expect(report.migrations).toEqual([...report.migrations].sort());
  });

  it("показывает, стоит ли запрет на смену sub", async () => {
    // Это ОБЯЗАТЕЛЬСТВО перед ПРАКТИКОЙ, а не деталь: у них наш sub
    // первичен для связи с человеком.
    expect((await schemaReport()).subImmutable).toBe(true);
  });

  it("пропажу запрета видно, а не приходится замечать", async () => {
    // Пустой или молчаливый ответ на вопрос «а запрет-то стоит?» —
    // худший исход: его принимают за «всё в порядке».
    await getPool().query("DROP TRIGGER accounts_id_immutable ON accounts");
    expect((await schemaReport()).subImmutable).toBe(false);
    // Возвращаем: следующие тесты в этом файле полагаются на запрет.
    await getPool().query(`
      CREATE TRIGGER accounts_id_immutable
        BEFORE UPDATE OF id ON accounts
        FOR EACH ROW EXECUTE FUNCTION accounts_id_is_immutable()`);
  });

  it("не выносит наружу ни строчки пользовательских данных", async () => {
    // Отчёт печатается в журнал прогона. Ни почты, ни sub, ни имён.
    // Ищутся признаки САМИХ данных, а не слова, похожие на них: «sub»
    // здесь — имя поля отчёта и часть имени миграции, и запрещать его
    // значило бы проверять орфографию вместо утечки.
    await createAccountWithEmail("noleak@ya.ru");
    const dump = JSON.stringify(await schemaReport());
    expect(dump).not.toContain("@");
    expect(dump, "в отчёте уникальный идентификатор — это чей-то sub")
      .not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
