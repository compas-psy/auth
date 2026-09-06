import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { serializeForLog } from "../src/lib/logging.js";
import { sha256, safeEqualHex } from "../src/lib/hash.js";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { writeAudit, listAudit } from "../src/services/audit.js";

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("У-9: журнал не содержит ПДн", () => {
  it("вырезает почту, sub и токены", () => {
    const line = serializeForLog({
      event: "login",
      email: "test@ya.ru",
      sub: "acc_8f21",
      token: "abc.def.ghi",
      ip_hash: "deadbeef",
    });
    expect(line).not.toContain("test@ya.ru");
    expect(line).not.toContain("acc_8f21");
    expect(line).not.toContain("abc.def.ghi");
    expect(line).toContain("deadbeef");
  });

  it("вырезает и во вложенных объектах, а не только на верхнем уровне", () => {
    const line = serializeForLog({
      event: "callback",
      request: { query: { code: "secret-code", state: "secret-state" } },
    });
    expect(line).not.toContain("secret-code");
    expect(line).not.toContain("secret-state");
  });

  it("вырезает путь: в нём едут идентификаторы", () => {
    const line = serializeForLog({ event: "req", path: "/v1/account/emails/acc_8f21" });
    expect(line).not.toContain("acc_8f21");
  });

  it("не зацикливается на ссылке на себя", () => {
    const o: Record<string, unknown> = { event: "x" };
    o.self = o;
    expect(() => serializeForLog(o)).not.toThrow();
  });
});

describe("хеши", () => {
  it("sha256 устойчив и не обратим по длине", () => {
    expect(sha256("1.2.3.4")).toBe(sha256("1.2.3.4"));
    expect(sha256("1.2.3.4")).toHaveLength(64);
    expect(sha256("1.2.3.4")).not.toBe(sha256("1.2.3.5"));
  });

  it("сравнение секретов не падает на разной длине и на мусоре", () => {
    expect(safeEqualHex(sha256("a"), sha256("a"))).toBe(true);
    expect(safeEqualHex(sha256("a"), sha256("b"))).toBe(false);
    expect(safeEqualHex("abc", "abcd")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
});

describe("журнал событий в базе", () => {
  it("хранит хеши, а не адрес и не user-agent", async () => {
    const { accountId } = await createAccountWithEmail("audit@ya.ru");
    await writeAudit({
      accountId, event: "login", outcome: "ok",
      ip: "203.0.113.7", ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/131",
    });
    const { rows } = await getPool().query("SELECT * FROM audit_log");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("203.0.113.7");
    expect(dump).not.toContain("Mozilla");
    expect(rows[0].ip_hash).toBe(sha256("203.0.113.7"));
    expect(rows[0].ua_hash).toHaveLength(64);
  });

  it("в схеме журнала нет колонок ip и user_agent", async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("ip");
    expect(cols).not.toContain("user_agent");
    expect(cols).toContain("ip_hash");
  });

  it("событие без аккаунта записывается: неудачный вход тоже событие", async () => {
    await writeAudit({ event: "email_start", outcome: "fail" });
    const { rows } = await getPool().query("SELECT count(*)::int n FROM audit_log");
    expect(rows[0].n).toBe(1);
  });

  it("удаление аккаунта не уносит его журнал, но обезличивает его", async () => {
    const { accountId } = await createAccountWithEmail("keep@ya.ru");
    await writeAudit({ accountId, event: "login", outcome: "ok" });
    await getPool().query("DELETE FROM accounts WHERE id = $1", [accountId]);
    const { rows } = await getPool().query("SELECT account_id FROM audit_log");
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBeNull();
  });

  it("журнал аккаунта отдаётся новыми событиями вперёд", async () => {
    const { accountId } = await createAccountWithEmail("list@ya.ru");
    await writeAudit({ accountId, event: "login", outcome: "ok" });
    await writeAudit({ accountId, event: "identity_linked", outcome: "ok", provider: "yandex" });
    const list = await listAudit(accountId, 10);
    expect(list[0]!.event).toBe("identity_linked");
    expect(list[0]!.provider).toBe("yandex");
    expect(list).toHaveLength(2);
  });
});
