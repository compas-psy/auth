import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { accountClaims } from "../src/oidc/provider.js";

/**
 * `sub` НЕИЗМЕНЕН НА ВС�ё ВРЕМЯ ЖИЗНИ УЧЁТНОЙ ЗАПИСИ.
 *
 * Это обязательство перед продуктом, а не свойство реализации. Агент
 * ПРАКТИКИ спросил прямо (issue compas-psy/cmpas.ru#132, 07.09.2026):
 * `Account.providerAccountId` у них — это наш `sub`, и он первичен для
 * связи. Если `sub` у одного человека когда-нибудь изменится, ПРАКТИКА
 * заведёт вторую строку `Account`, а при allowDangerousEmailAccountLinking
 * привяжет её к тому же пользователю по почте — и расхождения НЕ ЗАМЕТИТ.
 *
 * Обещание, не подкреплённое проверкой, — это обещание до первого
 * рефакторинга. Здесь оно подкреплено.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("sub не меняется", () => {
  it("база отвергает попытку сменить идентификатор", async () => {
    const { accountId } = await createAccountWithEmail("stable@ya.ru");
    await expect(getPool().query(
      "UPDATE accounts SET id = gen_random_uuid() WHERE id = $1", [accountId],
    )).rejects.toThrow();
  });

  it("отвергает и у записи без единой дочерней строки", async () => {
    // Проверка выше сначала была зелёной по ЧУЖОЙ причине: смену
    // отвергал внешний ключ из account_emails, а не запрет. У записи
    // без почты и способов входа UPDATE проходил — проверено вручную
    // в psql до этой правки. Гарантия обязана держаться сама, а не
    // на побочном следствии чужого ограничения.
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO accounts (display_name) VALUES (NULL) RETURNING id");
    await expect(getPool().query(
      "UPDATE accounts SET id = gen_random_uuid() WHERE id = $1", [rows[0]!.id],
    )).rejects.toThrow(/неизменен/);
  });

  it("после смены имени sub тот же", async () => {
    // Единственный UPDATE по таблице меняет display_name. Проверяется
    // не намерение, а результат.
    const { accountId } = await createAccountWithEmail("rename@ya.ru");
    const before = (await accountClaims(accountId))!.sub;
    await getPool().query(
      "UPDATE accounts SET display_name = 'Новое имя' WHERE id = $1", [accountId]);
    expect((await accountClaims(accountId))!.sub).toBe(before);
    expect(before).toBe(accountId);
  });

  it("добавление второй почты и способа входа sub не трогает", async () => {
    // Именно здесь его проще всего потерять: связывание — это место,
    // где два аккаунта встречаются.
    const { accountId } = await createAccountWithEmail("link@ya.ru");
    const before = (await accountClaims(accountId))!.sub;
    await getPool().query(
      "INSERT INTO account_emails (account_id, email, is_primary) VALUES ($1,$2,false)",
      [accountId, "second@ya.ru"]);
    await getPool().query(
      "INSERT INTO identities (account_id, provider, subject) VALUES ($1,'yandex','ya-1')",
      [accountId]);
    expect((await accountClaims(accountId))!.sub).toBe(before);
  });

  it("ни одна миграция не переписывает идентификаторы учётных записей", () => {
    // Правка данных миграцией — тихий способ сменить sub у живых людей.
    const dir = join(HERE, "../src/db/migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, file), "utf8");
      const bad = /UPDATE\s+accounts\s+SET\s+id\b/i.test(sql);
      expect({ file, rewritesId: bad }).toEqual({ file, rewritesId: false });
    }
  });
});
