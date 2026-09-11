import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "../../../docs/integration");

/**
 * Текст рецепта без разметки и переносов: утверждение проверяется по
 * смыслу, а не по тому, где markdown перенёс строку. Иначе тест начнёт
 * требовать вёрстки под себя вместо того, чтобы проверять содержание.
 */
function plainText(file: string): string {
  return readFileSync(join(DOCS, file), "utf8")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ");
}

/** Достаёт помеченный блок кода из рецепта. */
function extractBlock(file: string, name: string): string {
  const text = readFileSync(join(DOCS, file), "utf8");
  const re = new RegExp(`<!-- блок ${name} -->\\s*\`\`\`ts\\n([\\s\\S]*?)\`\`\``);
  const m = re.exec(text);
  if (!m) throw new Error(`в ${file} нет блока «${name}»`);
  return m[1]!;
}

/**
 * Разбирает блок конфигурации next-auth в объект.
 *
 * Блок — фрагмент реального файла, а не самостоятельный модуль:
 * оборачиваем его так, чтобы он стал вычислимым, не переписывая.
 */
function evalAuthConfig(file: string, name: string): { providers: Array<Record<string, unknown>> } {
  const block = extractBlock(file, name);
  const Yandex = (o: unknown) => ({ id: "yandex", ...(o as object) });
  const Nodemailer = (o: unknown) => ({ id: "nodemailer", ...(o as object) });
  const process = { env: {
    SIMPASID_ISSUER: "https://auth.cmpas.ru",
    SIMPASID_CLIENT_ID: "practice-web",
    SIMPASID_CLIENT_SECRET: "secret",
  } };
  // eslint-disable-next-line no-new-func
  const fn = new Function("Yandex", "Nodemailer", "process", `return { ${block} };`);
  return fn(Yandex, Nodemailer, process) as { providers: Array<Record<string, unknown>> };
}

describe("рецепты переезда исполняются, а не только читаются", () => {
  it("рецепт ПРАКТИКИ: конфигурация next-auth валидна и не трогает существующие провайдеры", () => {
    const cfg = evalAuthConfig("practice.md", "auth-config");
    expect(cfg.providers.map((p) => p.id)).toContain("simpasid");
    expect(cfg.providers.length).toBeGreaterThan(1); // старые способы остались
    expect((cfg as Record<string, unknown>).secret).toBeUndefined(); // AUTH_SECRET не переопределяется
  });

  it("рецепт ПРАКТИКИ: наш провайдер объявлен как oidc и выводит адреса из issuer", () => {
    const cfg = evalAuthConfig("practice.md", "auth-config");
    const simpas = cfg.providers.find((p) => p.id === "simpasid")!;
    expect(simpas.type).toBe("oidc");
    expect(simpas.issuer).toBe("https://auth.cmpas.ru");
    // wellKnown не задаётся: next-auth выводит его из issuer, и это
    // проверено через context7.
    expect(simpas.wellKnown).toBeUndefined();
  });

  it("рецепт ПРАКТИКИ: связывание по почте включено ТОЛЬКО у нашего провайдера", () => {
    const cfg = evalAuthConfig("practice.md", "auth-config");
    for (const p of cfg.providers) {
      const linking = p.allowDangerousEmailAccountLinking === true;
      expect({ id: p.id, linking }).toEqual({ id: p.id, linking: p.id === "simpasid" });
    }
  });

  it("рецепт ПРАКТИКИ: секреты берутся из окружения, а не вписаны в текст", () => {
    const block = extractBlock("practice.md", "auth-config");
    expect(block).toContain("process.env.SIMPASID_CLIENT_SECRET");
    expect(block).not.toMatch(/clientSecret:\s*["'][^"']{8,}["']/);
  });

  it("рецепт ЗАПИСОК: обмен кода реализуется вызовами SDK, без ручного HTTP", () => {
    const src = extractBlock("zapiski.md", "exchange");
    expect(src).toContain("exchangeCode");
    expect(src).not.toMatch(/fetch\(.*\/token/);
  });

  it("рецепт ЗАПИСОК: PKCE и nonce не забыты", () => {
    const src = extractBlock("zapiski.md", "exchange");
    expect(src).toContain("createPkcePair");
    expect(src).toContain("codeVerifier");
    expect(src).toContain("verifyIdToken");
    expect(src).toContain("nonce");
  });

  it("рецепт ЗАПИСОК: ключевой материал хранилища в рецепте не упоминается как передаваемый", () => {
    const text = plainText("zapiski.md");
    // И-1: рецепт обязан прямо запрещать это, а не умалчивать.
    expect(text).toContain("Не отправлять в единый вход ни пароль хранилища");
    expect(text).toContain("вход и разблокировка хранилища — разные действия");
  });

  it("оба рецепта запрещают трогать существующие строки", () => {
    for (const file of ["practice.md", "zapiski.md"]) {
      expect({ file, forbids: /UPDATE по/.test(plainText(file)) })
        .toEqual({ file, forbids: true });
    }
  });

  it("рецепт ПРАКТИКИ прямо запрещает менять AUTH_SECRET", () => {
    expect(plainText("practice.md")).toContain("Не менять AUTH_SECRET");
  });

  it("чек-лист состоит из семи проверяемых пунктов", () => {
    const text = readFileSync(join(DOCS, "checklist.md"), "utf8");
    const rows = text.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
    expect(rows).toHaveLength(7);
    // У каждого пункта есть колонка «чем доказывается» — непустая.
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      expect(cells[2]!.length).toBeGreaterThan(10);
    }
  });

  it("во всех рецептах верный адрес сервиса", () => {
    for (const file of ["practice.md", "zapiski.md", "checklist.md", "practice-android.md"]) {
      const text = readFileSync(join(DOCS, file), "utf8");
      expect(text).not.toContain("api.simpas.ru");
    }
  });
});

/**
 * Мобильный рецепт проверяется иначе, чем веб-рецепты: исполнить его
 * блоки на JVM отсюда нельзя. Зато можно потребовать, чтобы он не
 * обещал того, чего в клиенте нет, и не звал туда, куда требование
 * ходить запрещает.
 */
describe("мобильный рецепт ПРАКТИКИ", () => {
  const CLIENT = join(
    HERE, "../../../clients/android/src/main/kotlin/ru/cmpas/simpasid/SimpasIdClient.kt");
  const recipe = readFileSync(join(DOCS, "practice-android.md"), "utf8");
  const client = readFileSync(CLIENT, "utf8");

  it("каждый вызов из рецепта есть в клиенте", () => {
    // Переименование метода не должно тихо превращать рецепт в
    // документацию на несуществующее API.
    const called = new Set(
      [...recipe.matchAll(/simpasId\.([A-Za-z]+)\(/g)].map((m) => m[1]!));
    // Список задан явно: без него достаточно убрать «simpasId.» перед
    // вызовом, и проверка станет зелёной, ничего не проверяя. Так и
    // случилось при первом заходе.
    for (const required of
      ["authMethods", "startEmailAuth", "verifyEmailAuth", "exchangeProviderCode"]) {
      expect({ required, shown: called.has(required) }).toEqual({ required, shown: true });
    }
    for (const name of called) {
      expect({ name, exists: new RegExp(`fun ${name}\\(`).test(client) })
        .toEqual({ name, exists: true });
    }
  });

  it("чек-лист не запрещает того, что требует мобильный рецепт", () => {
    /*
     * Стоило нам положить в чек-лист строку из пакета макетов —
     * «формы входа внутри приложения нет: ни поля почты, ни кнопок
     * провайдеров, ни ввода кода из письма», — и агент продукта,
     * прочитав её буквально, собрался УБРАТЬ кнопку провайдера вместо
     * того, чтобы пересобрать её нативной. Поймано 11.09.2026 на живом
     * агенте ПРАКТИКИ, а не проверкой.
     *
     * Строка верна для веба и неверна для наших мобильных приложений,
     * где вход рисуется в приложении и идёт первичным токен-API
     * (12_NATIVE_AUTH.md). Запрет без этой оговорки уводит ровно в
     * противоположную сторону.
     */
    const checklist = readFileSync(join(DOCS, "checklist.md"), "utf8");
    expect(checklist).toContain("Наши мобильные приложения рисуют вход У СЕБЯ");
    expect(checklist).toContain("12_NATIVE_AUTH.md");
    // Запрет обязан быть отнесён к вебу, а не стоять безусловно.
    const unscoped = /\*\*Формы входа внутри приложения нет\*\*/.test(checklist);
    expect({ безусловныйЗапрет: unscoped }).toEqual({ безусловныйЗапрет: false });
  });

  it("оба документа запрещают закрывать дверь раньше, чем открыта новая", () => {
    // Переезд аддитивен. Выключение действующего способа входа до
    // того, как заменяющий проверен, превращает добавление единого
    // входа в изъятие.
    const checklist = readFileSync(join(DOCS, "checklist.md"), "utf8");
    expect(checklist).toContain("Работающую дверь не закрывают раньше");
    expect(recipe).toContain("не убираются, а ПЕРЕСОБИРАЮТСЯ");
  });

  it("платформы из рецепта объявлены в клиенте", () => {
    for (const m of recipe.matchAll(/Platform\.([A-Z]+)/g)) {
      expect({ v: m[1], known: client.includes(`${m[1]}("`) }).toEqual({ v: m[1], known: true });
    }
  });

  it("рецепт не зовёт в браузер и не предлагает webview", () => {
    const text = plainText("practice-android.md");
    for (const forbidden of ["Custom Tab", "WebView", "webview входа"]) {
      expect({ forbidden, mentionedAsWay: text.includes(`через ${forbidden}`) })
        .toEqual({ forbidden, mentionedAsWay: false });
    }
    expect(text).toContain("Ни Custom Tab, ни мобильный веб, ни редирект");
  });

  it("рецепт говорит про код из письма, а не про ссылку", () => {
    const text = plainText("practice-android.md");
    expect(text).toContain("код из письма, а не ссылка");
    expect(recipe).toContain("verifyEmailAuth");
  });

  it("рецепт предупреждает про общий OkHttpClient приложения", () => {
    // Единственное место, где ошибка отправляет ключ ПРАКТИКИ чужой
    // службе. Молчание рецепта здесь дороже любой другой неточности.
    const text = plainText("practice-android.md");
    expect(text).toContain("AuthInterceptor");
    expect(text).toContain("службе, которая его не просила");
  });

  it("рецепт не вписывает ключ доступа: у мобильного клиента его нет", () => {
    expect(recipe).not.toMatch(/clientSecret/);
    expect(plainText("practice-android.md")).toContain("first_party");
  });
});
