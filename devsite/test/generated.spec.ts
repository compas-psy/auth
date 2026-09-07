import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { buildSite, slug } from "../src/build.js";
import { parseChangelog } from "../src/changelog.js";

const SPEC = "../server/openapi/simpasid.v1.yaml";
const OUT = "dist";
const spec = parse(readFileSync(SPEC, "utf8"));

beforeAll(async () => { await buildSite({ specPath: SPEC, outDir: OUT }); });

describe("ресурс разработчика", () => {
  it("справочник собран из спецификации: каждый путь спеки имеет страницу", () => {
    const generated = readdirSync(join(OUT, "reference"));
    for (const p of Object.keys(spec.paths)) {
      expect(generated).toContain(`${slug(p)}.html`);
    }
  });

  it("ни одной страницы справочника сверх спецификации", () => {
    // Страница, которой нет в спеке, — это документация на ручку,
    // которой может не быть в реализации.
    const expected = new Set(Object.keys(spec.paths).map((p) => `${slug(p)}.html`));
    for (const file of readdirSync(join(OUT, "reference"))) {
      expect({ file, known: expected.has(file) }).toEqual({ file, known: true });
    }
  });

  it("страница ручки называет её поля из схемы, а не из головы", () => {
    const html = readFileSync(join(OUT, "reference", `${slug("/account/sessions")}.html`), "utf8");
    for (const field of ["id", "current", "platform", "client", "last_seen_at"]) {
      expect(html).toContain(field);
    }
  });

  /**
   * Пример из справочника разработчик копирует целиком. Пример с чужим
   * заголовком — это 403 и потерянный час на выяснение, почему ручка,
   * помеченная в спеке как открытая, отвечает отказом.
   */
  it("пример для первичного токен-API называет клиента, а не ключ доступа", () => {
    const html = readFileSync(
      join(OUT, "reference", `${slug("/auth/email/start")}.html`), "utf8");
    expect(html).toContain("X-Client-Id");
    expect(html).not.toContain("Authorization: Bearer");
  });

  it("пример для ручек аккаунта по-прежнему называет ключ доступа", () => {
    const html = readFileSync(
      join(OUT, "reference", `${slug("/account/sessions")}.html`), "utf8");
    expect(html).toContain("Authorization: Bearer");
  });

  /**
   * ProductCode объявлен растущим набором (x-extensible-enum), а не
   * закрытым enum. Справочник обязан всё равно называть значения:
   * иначе разработчик видит «string» и не знает ни одного продукта —
   * а узнать их больше неоткуда, справочник генерируется из спеки.
   * И обязан показать, что набор открыт, а не выдать его за полный.
   */
  it("растущий перечень значений напечатан и помечен как открытый", () => {
    const html = readFileSync(
      join(OUT, "reference", `${slug("/account")}.html`), "utf8");
    for (const product of spec.components.schemas.ProductCode["x-extensible-enum"]) {
      expect(html).toContain(product);
    }
    expect(html).toContain("…");
  });

  it("адрес в примерах — auth.cmpas.ru, а не устаревший api.simpas.ru", () => {
    for (const file of [join(OUT, "index.html"), ...readdirSync(join(OUT, "reference"))
      .map((f) => join(OUT, "reference", f))]) {
      const html = readFileSync(file, "utf8");
      expect(html).not.toContain("api.simpas.ru");
      if (html.includes("curl")) expect(html).toContain("auth.cmpas.ru");
    }
  });

  it("на титульной есть первый запрос и он адресован объявленному серверу", () => {
    const html = readFileSync(join(OUT, "index.html"), "utf8");
    expect(html).toContain("curl");
    expect(html).toContain(spec.servers[0].url);
  });

  it("правило, снимающее самодеятельность, напечатано на титульной", () => {
    const html = readFileSync(join(OUT, "index.html"), "utf8");
    expect(html).toContain("Если чего-то нет в спецификации");
  });

  it("границы, заданные схемой, названы на странице справочника", () => {
    const html = readFileSync(join(OUT, "reference", `${slug("/account/sessions")}.html`), "utf8");
    expect(html).toContain("телефона");
  });

  it("спецификация выложена рядом со справочником", () => {
    expect(existsSync(join(OUT, "simpasid.v1.yaml"))).toBe(true);
  });

  it("каждая запись журнала изменений помечена как ломающая или нет", () => {
    const entries = parseChangelog("../docs/CHANGELOG-api.md");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(["breaking", "non-breaking"]).toContain(entry.badge);
      if (entry.badge === "breaking") expect(entry.sunset).toBeTruthy();
    }
  });

  it("журнал изменений собран в страницу", () => {
    const html = readFileSync(join(OUT, "changelog.html"), "utf8");
    expect(html).toContain("Журнал изменений");
  });

  it("на страницах нет слов, запрещённых на экранах человека, но это ресурс разработчика", () => {
    // Здесь «токен» уместен: читатель — разработчик, а не человек,
    // входящий в ПРАКТИКУ. Проверяем обратное: что тут НЕ появилось
    // внутреннего API.
    for (const file of readdirSync(join(OUT, "reference"))) {
      const html = readFileSync(join(OUT, "reference", file), "utf8");
      expect(html).not.toContain("/internal");
    }
  });
});
