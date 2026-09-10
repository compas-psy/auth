import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { accountClaims } from "../src/oidc/provider.js";

/**
 * Claim `email` — только подтверждённый.
 *
 * next-auth ищет существующего пользователя продукта ПО ПОЧТЕ и
 * `email_verified` при этом НЕ смотрит (проверено через context7:
 * packages/core/src/lib/actions/callback/handle-login.ts — там
 * `getUserByEmail(profile.email)` и сразу связывание, если у провайдера
 * стоит allowDangerousEmailAccountLinking).
 *
 * Флаг этот в рецепте ПРАКТИКИ включается, и включается осознанно. Но
 * тогда неподтверждённая почта, попавшая в claim, — это готовый захват
 * чужой учётной записи продукта: назвал чужой адрес, вошёл в чужие
 * данные. Доверие к нам продукт оказал, ответственность на нас.
 */

const claimsFor = accountClaims;

beforeAll(async () => { await resetData(); });
beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

async function makeAccount(email: string, verified: boolean): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    "INSERT INTO accounts (display_name) VALUES (NULL) RETURNING id");
  const id = rows[0]!.id;
  await getPool().query(
    `INSERT INTO account_emails (account_id, email, verified_at, is_primary)
     VALUES ($1, $2, ${verified ? "now()" : "NULL"}, true)`,
    [id, email],
  );
  return id;
}

describe("claim email отдаётся только подтверждённым", () => {
  it("подтверждённая почта уходит в токен", async () => {
    const id = await makeAccount("ok@ya.ru", true);
    const claims = await claimsFor(id);
    expect(claims).toMatchObject({ email: "ok@ya.ru", email_verified: true });
  });

  it("неподтверждённая почта НЕ уходит в токен вовсе", async () => {
    // Не «уходит с email_verified: false», а не уходит: продукт,
    // связывающий по почте, не должен её увидеть даже случайно.
    const id = await makeAccount("нет@ya.ru", false);
    const claims = await claimsFor(id);
    expect(claims).toBeDefined();
    expect(claims!.email).toBeUndefined();
    expect(claims!.email_verified).toBe(false);
  });

  it("sub возвращается в обоих случаях: личность известна, почта — нет", async () => {
    const id = await makeAccount("нет2@ya.ru", false);
    expect((await claimsFor(id))!.sub).toBe(id);
  });
});

/**
 * Регистр адреса в claim не меняется — это договорённость с продуктом,
 * а не мелочь оформления.
 *
 * Мы храним адрес так, как человек его ввёл, а единственность держим по
 * lower(email). Отсюда риск: если продукт ищет человека точным
 * посимвольным сравнением, `Ivan@ya.ru` у нас и `ivan@ya.ru` у него не
 * совпадут — и вместо связывания заведётся ВТОРОЙ пользователь
 * продукта. Молча. Человек войдёт и увидит пустую практику вместо
 * своей.
 *
 * Вопрос задавался агенту ПРАКТИКИ четыре раза с двумя выходами на
 * выбор: сравнивать без регистра у себя — или мы приводим claim к
 * нижнему регистру. Ответ 10.09.2026 (cmpas.ru#132): сравнивают у себя,
 * claim просить не трогать. Довод их же: правка у нас закрыла бы только
 * новые входы через СИМПАС и не тронула бы адреса, заведённые у них
 * раньше — Яндексом, письмом, импортом.
 *
 * ПОЭТОМУ .toLowerCase() над claim'ом — НЕ улучшение. Это тихая отмена
 * договорённости, на которую другая сторона уже опирается своим кодом.
 * Захочется привести к нижнему регистру — сначала в переписку, потом в
 * код.
 */
describe("регистр адреса в claim", () => {
  it("отдаётся ровно так, как человек его ввёл", async () => {
    const id = await makeAccount("Ivan.Petrov@Ya.RU", true);
    expect((await claimsFor(id))?.email).toBe("Ivan.Petrov@Ya.RU");
  });

  it("нижний регистр тоже не трогается", async () => {
    const id = await makeAccount("ivan@ya.ru", true);
    expect((await claimsFor(id))?.email).toBe("ivan@ya.ru");
  });
});
