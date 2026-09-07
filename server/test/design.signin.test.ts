import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderScreen } from "../src/ui/render.js";
import { signIn } from "../src/ui/wording.js";

/**
 * Экран входа против МАКЕТА, а не против моей памяти о нём.
 *
 * Значения взяты из design/«СИМПАС - Единый вход.dc.html», артборд A1.
 * Расхождение интерфейса и макета — дефект приёмки, а не мелочь
 * (CLAUDE.md, «Правила интерфейса»), и четыре таких расхождения
 * дожили до боевого экрана: заглушки вместо знаков, дописанная
 * редакция, чужая шапка и кнопки вместо дисков.
 */

const asset = (name: string): string =>
  fileURLToPath(new URL(`../../portal/public/assets/${name}`, import.meta.url));

describe("знаки из макета лежат там, откуда их отдаёт сервер", () => {
  for (const file of [
    "simpas-mark.svg", "yandex-id.png", "t-id.svg", "sber-mark.png", "vk-id-blue.svg",
  ]) {
    it(`${file} на месте`, () => {
      // Заглушка вместо знака выглядит как сломанная картинка, а знаки
      // всё это время лежали в design/assets.
      expect(existsSync(asset(file))).toBe(true);
    });
  }
});

describe("юридическая строка — дословно из макета", () => {
  it("редакция на экране НЕ называется", () => {
    // В макете: «Продолжая, вы принимаете Пользовательское соглашение
    // СИМПАС. Как мы обращаемся с данными — в Политике…». Слова
    // «редакция 0.9» дописаны мной, в макете их нет.
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).not.toContain("редакция");
    expect(signIn.legalAccept()).not.toContain("редакция");
  });

  it("ссылка по-прежнему ведёт на КОНКРЕТНУЮ редакцию", () => {
    // Убрано только видимое упоминание. Что именно человек принял,
    // остаётся доказуемым: ссылка ведёт на неизменяемый адрес
    // редакции, и та же версия пишется в согласие.
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).toContain('href="/legal/terms/0.9"');
    expect(html).toContain('href="/legal/privacy/0.9"');
  });

  it("глагола принятия у Политики нет", () => {
    expect(signIn.legalPrivacy).not.toMatch(/принима/);
  });
});

describe("шапка экрана — как в макете", () => {
  it("знак СИМПАС стоит рядом с надписью", () => {
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).toContain("/assets/simpas-mark.svg");
    expect(html).toContain("СИМПАС");
  });

  it("название продукта — заголовок экрана", () => {
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).toContain("Вход в ПРАКТИКУ");
  });
});
