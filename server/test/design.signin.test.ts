import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderScreen } from "../src/ui/render.js";
import { signIn, account, PRODUCT_ACCUSATIVE } from "../src/ui/wording.js";
import { PRODUCTS } from "../src/services/accounts.js";

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
    // Шрифт лежит рядом со знаками: оболочка ссылается на эти файлы, и
    // отсутствующий файл даст молчаливую подмену гарнитуры.
    "fonts/geist-cyrillic.woff2", "fonts/geist-latin.woff2",
    "fonts/geist-cyrillic-ext.woff2", "fonts/geist-latin-ext.woff2",
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

/**
 * Вёрстка против нового пакета макетов (handoff 09.09.2026, артборд
 * A1-Р «Единый вход»).
 *
 * Экран выглядел плохо не из-за вкуса, а по вычислимой причине: Geist
 * НЕ ЗАГРУЖАЛСЯ вовсе. В токенах он назван, ссылки на файл шрифта нет
 * ни в оболочке, ни в стилях — весь экран рисовался системным шрифтом,
 * а рядом с ним рассыпаются и кегль, и ритм, рассчитанные под Geist.
 */
describe("шрифт действительно загружается", () => {
  const shell = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });

  const fonts = readFileSync(
    fileURLToPath(new URL("../../portal/src/styles/fonts.css", import.meta.url)), "utf8");

  it("шрифт грузится со своего домена, а не из Google Fonts", () => {
    // Экран входа — дверь по умолчанию для ПРАКТИКИ, а её люди сидят в
    // российских сетях, где Google Fonts блокируется. Заблокированный
    // запрос означает не «чуть позже», а подменный шрифт у части людей,
    // о котором мы не узнаем.
    expect(shell).not.toContain("fonts.googleapis.com");
    expect(shell).not.toContain("fonts.gstatic.com");
    expect(shell).toContain("/assets/fonts/geist-cyrillic.woff2");
  });

  it("кириллица подключена отдельным подмножеством", () => {
    // Сборка geistfont.vercel.app кириллицы НЕ содержит: заголовок молча
    // падает на подменный шрифт, и на экране оказывается смесь двух
    // гарнитур. Это и выглядит как «толстый и простой шрифт рядом».
    expect(fonts).toContain("geist-cyrillic.woff2");
    expect(fonts).toContain("U+0400-045F");
  });

  it("файл шрифта грузится заранее, иначе первый кадр перескочит", () => {
    expect(shell).toContain('rel="preload" as="font"');
  });

  it("одно объявление покрывает все начертания экрана", () => {
    // Geist вариативный: 400–800 в одном файле. Просить у браузера
    // меньше значит получить синтетическую жирность вместо настоящей.
    expect(fonts).toContain("font-weight: 400 800");
    expect(fonts).not.toMatch(/-webkit-text-stroke|text-shadow/);
  });
});

describe("экран входа не говорит про экосистему", () => {
  it("подписи «Один аккаунт СИМПАС — …» на входе нет", () => {
    // Решение учредителя 09.09.2026 по новому макету: человек входит в
    // КОНКРЕТНЫЙ продукт, и на этом экране про остальные ему знать
    // незачем. В артборде A1 этой строки нет вовсе.
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).not.toContain("Один аккаунт");
  });

  it("а в портале аккаунта — есть, и называет все продукты", () => {
    // Там он уже вошёл, и перечень продуктов — по делу.
    for (const p of PRODUCTS) {
      expect({ p, named: account.subtitle.includes(PRODUCT_ACCUSATIVE[p]) })
        .toEqual({ p, named: true });
    }
  });
});

/**
 * Геометрия против артборда A1. Проверяются числа, а не впечатление:
 * «примерно так же» — это и есть то, из-за чего экран выглядел плохо.
 */
describe("геометрия экрана входа — значения артборда", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../portal/src/styles/app.css", import.meta.url)), "utf8");
  const tokens = readFileSync(
    fileURLToPath(new URL("../../portal/src/styles/tokens.css", import.meta.url)), "utf8");

  /** Правило целиком, найденное по началу строки: иначе «h1 {» цепляет
   *  первое похожее вхождение вместе с чужим комментарием. */
  const rule = (selector: string): string => {
    const re = new RegExp(
      `^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
    const m = re.exec(css);
    expect(m, `в стилях нет правила ${selector}`).not.toBeNull();
    return m![1]!;
  };

  it("диск 56 и знак внутри 26 — ровно 46% диаметра", () => {
    // Разный оптический вес знаков читается как «этот вход главный»,
    // а главным не назначен ни один (задание 08 §4.1).
    const disc = rule(".provider-disc");
    expect(disc).toContain("width: 56px");
    expect(disc).toContain("height: 56px");
    expect(disc).toContain("background-size: 26px");
    expect(Math.round(56 * 0.46)).toBe(26);
  });

  it("ряд провайдеров не переносится ни на какой ширине", () => {
    // Два ряда по два читаются как две разные группы способов входа.
    expect(rule(".providers")).toContain("flex-wrap: nowrap");
    expect(rule(".providers")).toContain("gap: 20px");
  });

  it("заголовок 36/1.15, поле и кнопка 52, радиусы 14 и 20", () => {
    expect(rule("h1")).toContain("font-size: 36px");
    expect(rule('input[type="email"], input[type="text"]')).toContain("height: 52px");
    expect(rule(".primary-button")).toContain("height: 52px");
    expect(tokens).toContain("--radius-control: 14px");
    expect(tokens).toContain("--radius-card: 20px");
  });

  it("на узком экране знак не меньше 44 — это область нажатия", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 380px)"));
    expect(narrow).toContain("width: 44px");
  });

  it("юридическая строка отделена линией и не свёрнута", () => {
    expect(rule(".legal")).toContain("border-top: 1px solid var(--border)");
    // Свёрнутость проверяется на ЭКРАНЕ, а не в стилях: слово
    // «Подробнее» в комментарии таблицы стилей ничего не сворачивает,
    // и первая редакция этой проверки краснела именно на комментарии.
    const html = renderScreen("SignIn", { service: "practice", termsVersion: "0.9" });
    expect(html).not.toContain("Подробнее");
    expect(html).not.toContain("<details");
    expect(html).toContain("Пользовательское соглашение СИМПАС");
  });

  it("фокус с клавиатуры виден, и он золотой", () => {
    expect(tokens).toContain("--focus-ring");
    expect(rule(".provider-disc:focus-visible")).toContain("var(--focus-ring)");
  });

  it("ни одного цвета мимо палитры", () => {
    // Свой #888 или rgba(0,0,0,.5) на тексте — самый быстрый способ
    // сделать экран чужим самому себе.
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toUpperCase());
    // Палитра целиком объявлена в tokens.css; в app.css цвет берётся
    // только переменной.
    const allowed = new Set(["#DDE3DC"]); // граница знака при наведении
    for (const hex of hexes) {
      expect({ hex, known: allowed.has(hex) }).toEqual({ hex, known: true });
    }
    expect(css).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });
});

describe("ошибка не двигает экран", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../portal/src/styles/app.css", import.meta.url)), "utf8");

  it("карточка прижата к верху, а не центрирована по вертикали", () => {
    // Центрирование опрятно ровно до первой ошибки: добавленная строка
    // меняет высоту, и заголовок со знаками уезжает вверх на её
    // половину — под руками у человека, который читает сообщение об
    // ошибке. Замерено браузером: было 187 → 173, стало 182 → 182.
    const screen = /^\s*\.screen\s*\{([^}]*)\}/m.exec(css)![1]!;
    expect(screen).toContain("align-items: flex-start");
    expect(screen).not.toContain("align-items: center");
  });
});
