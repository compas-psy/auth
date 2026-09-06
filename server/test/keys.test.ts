import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateKeys, rotateKeys, publicJwks } from "../src/lib/keys.js";

let dir: string;
const made: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "simpasid-keys-"));
  made.push(dir);
});
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe("Р-3: ключи подписи сервис заводит себе сам", () => {
  it("при первом запуске ключ создаётся", () => {
    const set = loadOrCreateKeys(dir);
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0]!.kid).toBeTruthy();
    expect(set.keys[0]!.alg).toBe("RS256");
  });

  it("повторный запуск не меняет kid и не инвалидирует выданные токены", () => {
    const first = loadOrCreateKeys(dir);
    const second = loadOrCreateKeys(dir);
    expect(second.keys.map((k) => k.kid)).toEqual(first.keys.map((k) => k.kid));
    expect(second.keys[0]!.d).toBe(first.keys[0]!.d);
  });

  it("файл ключей лежит с режимом 600", () => {
    loadOrCreateKeys(dir);
    const mode = statSync(join(dir, "jwks.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("ротация добавляет новый ключ, оставляя прежний в наборе", () => {
    const before = loadOrCreateKeys(dir);
    const after = rotateKeys(dir);
    expect(after.keys).toHaveLength(2);
    expect(after.keys[0]!.kid).not.toBe(before.keys[0]!.kid);
    // Прежний остаётся: иначе ротация разлогинила бы всех разом.
    expect(after.keys[1]!.kid).toBe(before.keys[0]!.kid);
  });

  it("ротация не копит ключи бесконечно", () => {
    loadOrCreateKeys(dir);
    rotateKeys(dir); rotateKeys(dir); rotateKeys(dir);
    expect(readdirSync(dir)).toEqual(["jwks.json"]);
    expect(JSON.parse(readFileSync(join(dir, "jwks.json"), "utf8")).keys).toHaveLength(2);
  });

  it("публичная часть не содержит приватной", () => {
    const set = loadOrCreateKeys(dir);
    const pub = publicJwks(set);
    for (const k of pub.keys) {
      for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) {
        expect({ secret, present: secret in k }).toEqual({ secret, present: false });
      }
      expect(k.kid).toBe(set.keys[0]!.kid);
    }
  });

  it("приватный ключ не попадает ни в git, ни в образ", async () => {
    // Прямая проверка правил, а не обещание.
    const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
    expect(gitignore).toMatch(/\*\.jwk|keys\//);
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    // Ключи заводятся в томе, а не копируются в образ.
    expect(dockerfile).toContain('VOLUME ["/var/lib/simpasid"]');
    expect(dockerfile).not.toMatch(/COPY.*jwks\.json/);
  });
});
