import { createHash, timingSafeEqual } from "node:crypto";

/** sha256 в hex. Используется для ip_hash, ua_hash и хранения токенов. */
export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Сравнение секретов за постоянное время. Своего сравнения не пишем:
 * node:crypto делает это правильно, а посимвольное сравнение даёт
 * временной оракул.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
