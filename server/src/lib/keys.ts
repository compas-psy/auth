import { generateKeyPairSync, createPublicKey, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { logger } from "./logging.js";

export interface JwkSet {
  keys: Array<Record<string, unknown>>;
}

const FILE = "jwks.json";

/**
 * Ключи подписи id_token.
 *
 * Требование Р-3: учредитель не прописывает ничего руками — единственный
 * критичный секрет сервис заводит себе сам при первом запуске. Ключи
 * лежат в томе с режимом 600, в git и в образ не попадают, в окружении
 * не передаются, в лог печатается только kid.
 *
 * Собственной криптографии здесь нет: пара генерируется node:crypto,
 * экспорт в JWK — тоже им.
 */
export function loadOrCreateKeys(dir = loadConfig().keysDir): JwkSet {
  const path = join(dir, FILE);
  if (existsSync(path)) {
    const set = JSON.parse(readFileSync(path, "utf8")) as JwkSet;
    if (Array.isArray(set.keys) && set.keys.length > 0) {
      logger.info({ event: "keys_loaded", kids: set.keys.map((k) => k.kid) });
      return set;
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const set: JwkSet = { keys: [newKey()] };
  writeSet(path, set);
  logger.info({ event: "keys_generated", kids: set.keys.map((k) => k.kid) });
  return set;
}

/**
 * Ротация: новый ключ добавляется первым, прежний остаётся в JWKS на срок
 * перекрытия. Ротация не разлогинивает: токены, подписанные прежним kid,
 * продолжают проверяться (02_SIMPASID.md §3.4 п. 6).
 */
export function rotateKeys(dir = loadConfig().keysDir, keep = 2): JwkSet {
  const path = join(dir, FILE);
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as JwkSet)
    : { keys: [] };
  const set: JwkSet = { keys: [newKey(), ...current.keys].slice(0, keep) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeSet(path, set);
  logger.info({ event: "keys_rotated", kids: set.keys.map((k) => k.kid) });
  return set;
}

function newKey(): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid: randomUUID(), use: "sig", alg: "RS256" };
}

function writeSet(path: string, set: JwkSet): void {
  writeFileSync(path, JSON.stringify(set, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Публичная часть — для проверки, что приватная наружу не уходит. */
export function publicJwks(set: JwkSet): JwkSet {
  return {
    keys: set.keys.map((k) => {
      const pub = createPublicKey({ key: k as never, format: "jwk" });
      const jwk = pub.export({ format: "jwk" }) as Record<string, unknown>;
      return { ...jwk, kid: k.kid, use: k.use, alg: k.alg };
    }),
  };
}

if (process.argv[2] === "rotate") {
  const set = rotateKeys();
  process.stdout.write(`rotated; kids: ${set.keys.map((k) => k.kid).join(", ")}\n`);
}
