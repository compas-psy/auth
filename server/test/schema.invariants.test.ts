import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// План приводит этот файл в CommonJS с __dirname. Сервер собран как ESM
// ("type": "module"), где __dirname не существует, — путь берётся из
// import.meta.url. Расхождение с планом зафиксировано в отчёте Задачи 1.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../src/db/migrations");

// И-2: список дословно из CLAUDE.md и docs/plan/E2.md §«Глобальные ограничения».
const FORBIDDEN = [
  "password", "password_hash", "passphrase", "vault_key", "master_key",
  "wrapped_key", "key_material", "recovery_key", "kek", "secret_key",
  "phone", "otp", "sms_code",
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

function allMigrationSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n")
    .toLowerCase();
}

// Комментарии вырезаются: инвариант про имена колонок, а не про то, что
// запрещённое слово нельзя назвать в пояснении, почему его тут нет.
function sqlWithoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("И-2: запрещённые колонки", () => {
  it("миграции не содержат ни одного запрещённого имени колонки", () => {
    const sql = sqlWithoutComments(allMigrationSql());
    const found = FORBIDDEN.filter((name) => new RegExp(`\\b${name}\\b`).test(sql));
    expect(found).toEqual([]);
  });

  it("производные запрещённых имён тоже не проходят", () => {
    const sql = sqlWithoutComments(allMigrationSql());
    // Производная — запрещённое слово как часть идентификатора:
    // user_password, otp_code, phone_number, sms_code_hash.
    const derived = FORBIDDEN.filter((name) =>
      new RegExp(`[a-z0-9_]*${name}[a-z0-9_]*`).test(sql),
    );
    expect(derived).toEqual([]);
  });

  it("каталог миграций существует и не пуст", () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it("миграции пронумерованы без пропусков и без дублей", () => {
    const numbers = migrationFiles().map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i));
  });
});
