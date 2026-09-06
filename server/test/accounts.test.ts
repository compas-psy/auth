import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import {
  createAccountWithEmail,
  findAccountByEmail,
  linkProduct,
  listProducts,
} from "../src/services/accounts.js";

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("учётные записи", () => {
  it("создаёт запись с подтверждённой основной почтой", async () => {
    const { accountId } = await createAccountWithEmail("Test@Ya.RU");
    const found = await findAccountByEmail("test@ya.ru");
    expect(found?.accountId).toBe(accountId);
  });

  it("почта уникальна без учёта регистра", async () => {
    await createAccountWithEmail("a@ya.ru");
    await expect(createAccountWithEmail("A@YA.RU")).rejects.toThrow();
  });

  it("почта хранится как введена, а ищется без учёта регистра", async () => {
    await createAccountWithEmail("Ivan.Petrov@Ya.ru");
    const { rows } = await getPool().query("SELECT email FROM account_emails");
    expect(rows[0].email).toBe("Ivan.Petrov@Ya.ru");
    expect(await findAccountByEmail("IVAN.PETROV@ya.RU")).not.toBeNull();
  });

  it("основная почта у записи ровно одна", async () => {
    const { accountId } = await createAccountWithEmail("p@ya.ru");
    await expect(
      getPool().query(
        `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
         VALUES ($1, 'p2@ya.ru', now(), true)`,
        [accountId],
      ),
    ).rejects.toThrow();
  });

  it("неподтверждённая почта не даёт войти", async () => {
    const { accountId } = await createAccountWithEmail("v@ya.ru");
    await getPool().query(
      `INSERT INTO account_emails (account_id, email, is_primary) VALUES ($1,'unv@ya.ru',false)`,
      [accountId],
    );
    expect(await findAccountByEmail("unv@ya.ru")).toBeNull();
  });

  it("связь с продуктом идемпотентна и видна в перечне", async () => {
    const { accountId } = await createAccountWithEmail("pl@ya.ru");
    await linkProduct(accountId, "practice", "user-1");
    await linkProduct(accountId, "practice", "user-1");
    expect(await listProducts(accountId)).toEqual(["practice"]);
  });

  it("один пользователь продукта не связывается с двумя учётными записями", async () => {
    const a = await createAccountWithEmail("one@ya.ru");
    const b = await createAccountWithEmail("two@ya.ru");
    await linkProduct(a.accountId, "practice", "shared-user");
    await linkProduct(b.accountId, "practice", "shared-user");
    expect(await listProducts(b.accountId)).toEqual([]);
  });

  it("удалённая запись не находится по почте", async () => {
    const { accountId } = await createAccountWithEmail("del@ya.ru");
    await getPool().query("UPDATE accounts SET status = 'deleted' WHERE id = $1", [accountId]);
    expect(await findAccountByEmail("del@ya.ru")).toBeNull();
  });
});
