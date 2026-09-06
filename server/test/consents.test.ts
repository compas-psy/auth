import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";
import { recordConsent, effectiveState, listAcceptedDocuments } from "../src/services/consents.js";

let accountId: string;
beforeEach(async () => {
  await resetData();
  ({ accountId } = await createAccountWithEmail("c@ya.ru"));
});
afterAll(async () => { await closePool(); });

const base = {
  documentCode: "cmpas_marketing_consent",
  documentVersion: "0.9",
  contentHash: "a".repeat(64),
  action: "switch_marketing_email",
  source: "web" as const,
};

describe("журнал согласий", () => {
  it("отзыв создаёт новую запись, а не правит старую", async () => {
    await recordConsent({ ...base, accountId, channel: "email", status: "granted" });
    await recordConsent({ ...base, accountId, channel: "email", status: "revoked" });
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM consent_events WHERE account_id = $1", [accountId]);
    expect(rows[0].n).toBe(2);
  });

  it("действующее состояние берётся из последнего события по каналу", async () => {
    await recordConsent({ ...base, accountId, channel: "email", status: "granted" });
    await recordConsent({ ...base, accountId, channel: "push", status: "granted" });
    await recordConsent({ ...base, accountId, channel: "email", status: "revoked" });
    const state = await effectiveState(accountId);
    expect(state.find((s) => s.channel === "email")?.status).toBe("revoked");
    expect(state.find((s) => s.channel === "push")?.status).toBe("granted");
  });

  it("журнал неизменяем: UPDATE отклоняется базой", async () => {
    await recordConsent({ ...base, accountId, channel: "email", status: "granted" });
    await expect(
      getPool().query("UPDATE consent_events SET status = 'revoked'"),
    ).rejects.toThrow(/append-only/);
  });

  it("журнал неизменяем: DELETE отклоняется базой", async () => {
    await recordConsent({ ...base, accountId, channel: "email", status: "granted" });
    await expect(
      getPool().query("DELETE FROM consent_events"),
    ).rejects.toThrow(/append-only/);
  });

  it("два события в одну миллисекунду упорядочены детерминированно", async () => {
    // Без tie-break по возрастающему номеру два события с одинаковым
    // occurred_at дают случайный «последний», и состояние скачет.
    await getPool().query(
      `INSERT INTO consent_events
         (account_id, document_code, document_version, content_hash, status,
          action, source, channel, occurred_at)
       VALUES
         ($1,'cmpas_marketing_consent','0.9',$2,'granted','a','web','email','2026-09-06T10:00:00Z'),
         ($1,'cmpas_marketing_consent','0.9',$2,'revoked','a','web','email','2026-09-06T10:00:00Z')`,
      [accountId, "a".repeat(64)],
    );
    const state = await effectiveState(accountId);
    expect(state.find((s) => s.channel === "email")?.status).toBe("revoked");
  });

  it("версия и хеш текста сохраняются: без них согласие недоказуемо", async () => {
    await recordConsent({ ...base, accountId, channel: "email", status: "granted" });
    const { rows } = await getPool().query(
      "SELECT document_version, content_hash FROM consent_events WHERE account_id = $1",
      [accountId]);
    expect(rows[0].document_version).toBe("0.9");
    expect(rows[0].content_hash).toBe("a".repeat(64));
  });

  it("принятые документы отдаются с редакцией и неизменяемой ссылкой", async () => {
    await recordConsent({
      ...base, accountId, documentCode: "cmpas_terms", action: "signin_button",
      status: "granted", channel: undefined,
    });
    const accepted = await listAcceptedDocuments(accountId);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ documentCode: "cmpas_terms", version: "0.9" });
    expect(accepted[0]!.immutableUrl).toBe("/legal/terms/0.9");
  });

  it("отозванный документ в перечне принятых не показывается", async () => {
    await recordConsent({ ...base, accountId, documentCode: "cmpas_terms",
      status: "granted", channel: undefined });
    await recordConsent({ ...base, accountId, documentCode: "cmpas_terms",
      status: "revoked", channel: undefined });
    expect(await listAcceptedDocuments(accountId)).toHaveLength(0);
  });

  it("неизвестный код документа отклоняется внешним ключом", async () => {
    await expect(recordConsent({
      ...base, accountId, documentCode: "cmpas_not_a_document", status: "granted",
    })).rejects.toThrow();
  });
});
