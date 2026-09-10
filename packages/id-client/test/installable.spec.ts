import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Пакет обязан ставиться ИЗ GIT, а не только собираться у нас.
 *
 * Рецепты переезда прямо запрещают продукту писать обмен кода руками:
 * проверка подписи и сверка nonce — то место, где ошибаются. Значит
 * пакет должен ставиться. В npm он не опубликован, остаётся установка
 * из git — а она собирает пакет ТОЛЬКО если есть скрипт prepare.
 *
 * Без него npm скачивает исходники, ничего не собирает, и main
 * указывает на несуществующий dist/. Отказ приходит не при установке,
 * а при первом импорте — у того, кто взял наш рецепт и поверил ему.
 *
 * Нашёл агент ЗАПИСОК (compas-psy/zapiski#4, 10.09.2026): он не смог
 * поставить пакет и остановился, потому что рецепт запрещал обойти его
 * руками. Правильно остановился.
 */

function pkg(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

describe("установка пакета из git", () => {
  it("prepare собирает dist при установке", () => {
    const scripts = pkg().scripts as Record<string, string>;
    expect(scripts.prepare, "без prepare установка из git даёт пустой dist").toBeTruthy();
    expect(scripts.prepare).toContain("build");
  });

  it("то, на что указывает main, лежит в dist — который и собирается", () => {
    const p = pkg();
    expect(String(p.main)).toContain("dist/");
    expect(p.files).toContain("dist");
  });

  it("сборка не требует чужих девзависимостей на стороне продукта", () => {
    // prepare выполняется у ТОГО, КТО СТАВИТ. Всё, что нужно сборке,
    // обязано лежать в devDependencies самого пакета.
    const dev = pkg().devDependencies as Record<string, string>;
    expect(dev.typescript, "сборка зовёт tsc — он должен ставиться с пакетом").toBeTruthy();
  });
});
