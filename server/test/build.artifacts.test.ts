import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const SRC_MIGRATIONS = join(SERVER, "src/db/migrations");

const sqlNames = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("миграции доезжают до собранного кода", () => {
  it("в исходниках миграции есть — иначе проверка ниже пуста", () => {
    expect(sqlNames(SRC_MIGRATIONS).length).toBeGreaterThan(5);
  });

  it("сборка копирует их: tsc переносит только .ts", () => {
    // Сервис ищет миграции рядом с собой: в разработке это
    // src/db/migrations, в образе — dist/db/migrations. tsc .sql не
    // копирует, и контейнер падал при СТАРТЕ на боевом сервере:
    // ENOENT ... scandir '/app/dist/db/migrations'. Ни один тест
    // этого не видел: тесты идут от исходников.
    const out = mkdtempSync(join(tmpdir(), "simpasid-migrations-"));
    execFileSync("node", [join(SERVER, "scripts/copy-migrations.mjs"), out], {
      cwd: SERVER,
      encoding: "utf8",
    });
    expect(sqlNames(join(out, "db/migrations"))).toEqual(sqlNames(SRC_MIGRATIONS));
  });

  it("копирование подключено к сборке, а не лежит рядом", () => {
    const pkg = JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("copy-migrations.mjs");
  });

  it("копируются только миграции, ничего лишнего", () => {
    // Скрипт сборки, тащащий в образ всё подряд, однажды затащит и
    // то, чему там не место.
    const out = mkdtempSync(join(tmpdir(), "simpasid-migrations-only-"));
    execFileSync("node", [join(SERVER, "scripts/copy-migrations.mjs"), out], { cwd: SERVER });
    expect(readdirSync(out)).toEqual(["db"]);
    expect(readdirSync(join(out, "db"))).toEqual(["migrations"]);
    expect(readdirSync(join(out, "db/migrations")).every((f) => f.endsWith(".sql"))).toBe(true);
  });

  it("повторный запуск не ломается о уже существующий каталог", () => {
    // Пересборка в том же дереве — обычное дело.
    const out = mkdtempSync(join(tmpdir(), "simpasid-migrations-twice-"));
    for (let i = 0; i < 2; i += 1) {
      execFileSync("node", [join(SERVER, "scripts/copy-migrations.mjs"), out], { cwd: SERVER });
    }
    expect(existsSync(join(out, "db/migrations"))).toBe(true);
  });
});
