/**
 * Журнал сервиса. Требование У-9 (`02_SIMPASID.md` §8, CLAUDE.md «Журналы»):
 * ни почта, ни sub, ни токены, ни пути в лог не попадают никогда.
 * Разрешено ровно то, что не опознаёт человека: ip_hash, ua_hash, событие,
 * исход, семейство платформы.
 */
const REDACT = new Set([
  "email", "sub", "token", "id_token", "access_token", "refresh_token",
  "code", "state", "path", "storage_key", "account_id", "accountId",
  "subject", "provider_code", "device_key", "url", "authorization",
  "cookie", "set-cookie", "nonce", "redirect_uri", "user_agent", "ip",
]);

const MAX_DEPTH = 4;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function serializeForLog(o: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    safe[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redactValue(v, 1);
  }
  return JSON.stringify(safe);
}

type Level = "info" | "warn" | "error";

function emit(level: Level, o: Record<string, unknown>): void {
  const line = serializeForLog({ level, at: new Date().toISOString(), ...o });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  info: (o: Record<string, unknown>) => emit("info", o),
  warn: (o: Record<string, unknown>) => emit("warn", o),
  error: (o: Record<string, unknown>) => emit("error", o),
};
