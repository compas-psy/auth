import { getPool } from "../db/pool.js";
import { sha256 } from "../lib/hash.js";
import { logger } from "../lib/logging.js";

export interface AuditInput {
  accountId?: string | null;
  event: string;
  provider?: string | null;
  outcome: "ok" | "fail";
  /** Сырой адрес и user-agent принимаются, но НЕ сохраняются: только хеш. */
  ip?: string | null;
  ua?: string | null;
}

export interface AuditEntry {
  id: string;
  event: string;
  provider: string | null;
  outcome: "ok" | "fail";
  at: string;
}

export async function writeAudit(e: AuditInput): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO audit_log (account_id, event, provider, outcome, ip_hash, ua_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        e.accountId ?? null,
        e.event,
        e.provider ?? null,
        e.outcome,
        e.ip ? sha256(e.ip) : null,
        e.ua ? sha256(e.ua) : null,
      ],
    );
  } catch {
    // Журнал не вправе уронить вход: не записанное событие хуже, чем
    // незаписанное И не пущенный человек. Само событие сбоя видно в логе.
    logger.warn({ event: "audit_write", outcome: "fail" });
  }
}

export async function listAudit(accountId: string, limit = 50): Promise<AuditEntry[]> {
  const { rows } = await getPool().query(
    `SELECT id, event, provider, outcome, at FROM audit_log
     WHERE account_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [accountId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    provider: r.provider,
    outcome: r.outcome,
    at: r.at.toISOString(),
  }));
}
