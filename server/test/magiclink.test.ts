import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { issueMagicLink, redeemMagicLink } from "../src/services/magicLink.js";
import { createAccountWithEmail } from "../src/services/accounts.js";

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

const req = { email: "m@ya.ru", deviceKey: "dev-1", platform: "web" as const };

function token(r: Awaited<ReturnType<typeof issueMagicLink>>): string {
  if ("throttled" in r) throw new Error("unexpected throttle");
  return r.token;
}

describe("вход по почте", () => {
  it("сырой токен в базе не хранится", async () => {
    const t = token(await issueMagicLink(req));
    const { rows } = await getPool().query("SELECT * FROM magic_link_tokens");
    expect(JSON.stringify(rows)).not.toContain(t);
  });

  it("токен одноразовый", async () => {
    const t = token(await issueMagicLink(req));
    expect(await redeemMagicLink(t)).not.toBeNull();
    expect(await redeemMagicLink(t)).toBeNull();
  });

  it("повтор чаще 60 секунд отклоняется сервером", async () => {
    await issueMagicLink(req);
    expect(await issueMagicLink(req)).toEqual({ throttled: true, retryAfterSeconds: 60 });
  });

  it("пауза считается по адресу без учёта регистра", async () => {
    await issueMagicLink(req);
    const second = await issueMagicLink({ ...req, email: "M@YA.RU" });
    expect("throttled" in second).toBe(true);
  });

  it("первое погашение создаёт учётную запись с подтверждённой почтой", async () => {
    const t = token(await issueMagicLink(req));
    const out = await redeemMagicLink(t);
    const { rows } = await getPool().query(
      "SELECT verified_at, is_primary FROM account_emails WHERE account_id = $1",
      [out!.accountId]);
    expect(rows[0].verified_at).not.toBeNull();
    expect(rows[0].is_primary).toBe(true);
  });

  it("второй вход тем же адресом попадает в ту же запись", async () => {
    const first = await redeemMagicLink(token(await issueMagicLink(req)));
    await getPool().query("DELETE FROM magic_link_tokens");
    const second = await redeemMagicLink(token(await issueMagicLink(req)));
    expect(second!.accountId).toBe(first!.accountId);
    expect(second!.created).toBe(false);
    expect(first!.created).toBe(true);
  });

  it("просроченный токен не гасится", async () => {
    const t = token(await issueMagicLink(req));
    await getPool().query("UPDATE magic_link_tokens SET expires_at = now() - interval '1 minute'");
    expect(await redeemMagicLink(t)).toBeNull();
  });

  it("срок жизни ссылки — 15 минут", async () => {
    await issueMagicLink(req);
    const { rows } = await getPool().query(
      "SELECT expires_at - created_at AS ttl FROM magic_link_tokens");
    expect(rows[0].ttl.minutes).toBe(15);
  });

  it("подделанный токен не проходит", async () => {
    await issueMagicLink(req);
    expect(await redeemMagicLink("не-тот-токен")).toBeNull();
  });

  it("токен привязан к устройству, с которого начат вход", async () => {
    const t = token(await issueMagicLink(req));
    const { rows } = await getPool().query("SELECT device_key, platform FROM magic_link_tokens");
    expect(rows[0].device_key).toBe("dev-1");
    expect(rows[0].platform).toBe("web");
    expect(await redeemMagicLink(t)).not.toBeNull();
  });

  it("два параллельных погашения дают ровно один вход", async () => {
    // Гонка двух вкладок не должна заводить две учётные записи
    // и не должна пускать дважды по одному токену.
    const t = token(await issueMagicLink(req));
    const results = await Promise.all([redeemMagicLink(t), redeemMagicLink(t)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("согласия едут вместе с токеном: записать их раньше некуда", async () => {
    // Аккаунта в момент нажатия ещё нет (задание 08 §2.5).
    const t = token(await issueMagicLink({ ...req, termsVersion: "0.9" }));
    const out = await redeemMagicLink(t);
    const { rows } = await getPool().query(
      `SELECT document_code, status, action FROM consent_events WHERE account_id = $1`,
      [out!.accountId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].document_code).toBe("cmpas_terms");
    expect(rows[0].status).toBe("granted");
  });

  it("повторный вход не пишет акцепт заново", async () => {
    const first = await redeemMagicLink(token(await issueMagicLink({ ...req, termsVersion: "0.9" })));
    await getPool().query("DELETE FROM magic_link_tokens");
    await redeemMagicLink(token(await issueMagicLink({ ...req, termsVersion: "0.9" })));
    const { rows } = await getPool().query(
      "SELECT count(*)::int n FROM consent_events WHERE account_id = $1", [first!.accountId]);
    expect(rows[0].n).toBe(1);
  });

  it("выпуск для существующего адреса не раскрывает, что он существует", async () => {
    await createAccountWithEmail("known@ya.ru");
    const a = await issueMagicLink({ ...req, email: "known@ya.ru" });
    const b = await issueMagicLink({ ...req, email: "unknown@ya.ru" });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});
