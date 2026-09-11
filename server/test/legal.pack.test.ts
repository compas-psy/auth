import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getPool, closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";
import { readLegalText, publishLegalTexts } from "../src/services/legalTexts.js";

/**
 * Приёмка поставки текстов 0.9 — 16_LEGAL_TEXTS_PUBLISH.md §5.
 *
 * Отпечатки ниже — не вычисленные здесь, а ПРИСЛАННЫЕ вместе с
 * текстами (опись, §1). В этом весь смысл проверки: хеш, посчитанный
 * из того же файла, подтверждает только то, что файл не изменился с
 * прошлой строки кода. Сверка с описью подтверждает, что в репозиторий
 * приехало ровно то, что уезжало из проекта КОМПАС.
 *
 * Отсюда же следует, почему числа зашиты в тест намертво: редакция 0.9
 * неизменяема по замыслу (0014_legal_canon.sql). День, когда эта
 * проверка покраснеет, — это день, когда кто-то поправил опубликованный
 * юридический текст. Чинить надо не тест.
 */
const МАНИФЕСТ = [
  { code: "cmpas_terms",             bytes: 16183, hash: "9f74a94716b97bab4b71bbd23ec15533493038f21826a151f5749e6cbbca8675", url: "/legal/terms/0.9" },
  { code: "cmpas_privacy",           bytes: 18030, hash: "c0cff1a73ce088c99201adecce08ed050eb07fed7958bfe9ef5c7f2ada558542", url: "/legal/privacy/0.9" },
  { code: "cmpas_professional",      bytes: 15073, hash: "6f56f768389992f71e86159a19669aae9fa26e4d048db99d4ba8da35982ddb24", url: "/legal/professional/0.9" },
  { code: "cmpas_practice_terms",    bytes: 7984,  hash: "c58c9005cb7a705c03784ab386408259b6cb0fd28684167af3d3185d9b311d33", url: "/legal/practice-terms/0.9" },
  { code: "cmpas_notes_terms",       bytes: 5873,  hash: "8648385d0bc9ca71f81161e328e5b634acb1e6682a9d1bece6087dc4f727914a", url: "/legal/notes-terms/0.9" },
  { code: "cmpas_moments_terms",     bytes: 5706,  hash: "0fe67b72daf92b7b3b26343bf7593864ce22d6cd3962c09eaec24468f963a999", url: "/legal/moments-terms/0.9" },
  { code: "cmpas_marketing_consent", bytes: 5556,  hash: "cd8a54dfd91206461c5a445801c961427fc44e5a0f5706ff9da9bbca21868230", url: "/legal/marketing-consent/0.9" },
];
const ВЕРСИЯ = "0.9";

/** Каталог текстов репозитория — тот самый, который Dockerfile кладёт в /app/legal. */
const REPO_LEGAL = resolve(fileURLToPath(new URL("../../legal", import.meta.url)));

let savedDir: string | undefined;

beforeAll(async () => {
  await ensureSchema();
  savedDir = process.env.LEGAL_TEXTS_DIR;
  process.env.LEGAL_TEXTS_DIR = REPO_LEGAL;
});

afterAll(async () => {
  if (savedDir === undefined) delete process.env.LEGAL_TEXTS_DIR;
  else process.env.LEGAL_TEXTS_DIR = savedDir;
  await closePool();
});

describe("Т-2 файлы совпали с описью байт в байт", () => {
  for (const doc of МАНИФЕСТ) {
    it(`${doc.code}: ${doc.bytes} байт и присланный отпечаток`, () => {
      const file = join(REPO_LEGAL, doc.code, `${ВЕРСИЯ}.md`);
      expect(existsSync(file), `нет файла ${file}`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.byteLength).toBe(doc.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.hash);
    });
  }

  it("сервис считает тот же отпечаток, что и опись", () => {
    for (const doc of МАНИФЕСТ) {
      expect(readLegalText(doc.code, ВЕРСИЯ)?.hash).toBe(doc.hash);
    }
  });
});

describe("тексты приехали целыми", () => {
  /**
   * Плейсхолдер, попавший под отпечаток, остаётся в документе навсегда:
   * редакцию переписать нельзя. Ровно на этом 11.09.2026 остановилась
   * публикация двух центральных документов.
   */
  it("ни в одном тексте не осталось незаполненного места {{…}}", () => {
    for (const doc of МАНИФЕСТ) {
      const source = readLegalText(doc.code, ВЕРСИЯ)!.source;
      expect(source, `${doc.code} содержит плейсхолдер`).not.toMatch(/\{\{[^}]*\}\}/);
    }
  });

  it("файл заканчивается одним переводом строки и не содержит \\r", () => {
    for (const doc of МАНИФЕСТ) {
      const source = readLegalText(doc.code, ВЕРСИЯ)!.source;
      expect(source, `${doc.code}: перевод строки Windows`).not.toContain("\r");
      expect(source.endsWith("\n") && !source.endsWith("\n\n"), `${doc.code}: хвост файла`).toBe(true);
    }
  });
});

describe("каталог текстов и реестр сходятся", () => {
  it("у каждого положенного текста есть заведённая редакция", async () => {
    const каталоги = readdirSync(REPO_LEGAL, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    const { rows } = await getPool().query<{ code: string }>(
      "SELECT code FROM legal_document_versions WHERE version = $1", [ВЕРСИЯ]);
    const заведены = new Set(rows.map((r) => r.code));
    for (const каталог of каталоги) {
      expect(заведены.has(каталог), `текст ${каталог} лежит, но редакции ${ВЕРСИЯ} в реестре нет`).toBe(true);
    }
  });

  it("адрес редакции в реестре — тот, что назван в описи", async () => {
    for (const doc of МАНИФЕСТ) {
      const { rows } = await getPool().query<{ immutable_url: string }>(
        "SELECT immutable_url FROM legal_document_versions WHERE code = $1 AND version = $2",
        [doc.code, ВЕРСИЯ]);
      expect(rows[0]?.immutable_url).toBe(doc.url);
    }
  });
});

describe("Т-1 публикация при запуске", () => {
  it("семь редакций получают настоящий отпечаток, а не PENDING", async () => {
    await publishLegalTexts();
    for (const doc of МАНИФЕСТ) {
      const { rows } = await getPool().query<{ content_hash: string }>(
        "SELECT content_hash FROM legal_document_versions WHERE code = $1 AND version = $2",
        [doc.code, ВЕРСИЯ]);
      expect(rows[0]?.content_hash, doc.code).toBe(doc.hash);
    }
  });

  it("Т-8 согласие клиента психолога честно остаётся без текста", async () => {
    expect(readLegalText("practice_client_consent", ВЕРСИЯ)).toBeNull();
    const { rows } = await getPool().query<{ content_hash: string }>(
      "SELECT content_hash FROM legal_document_versions WHERE code = 'practice_client_consent' AND version = $1",
      [ВЕРСИЯ]);
    expect(rows[0]?.content_hash).toBe("PENDING");
  });

  it("Т-9 ШАГИ по-прежнему без действующей редакции", async () => {
    const { rows } = await getPool().query<{ current_version: string | null }>(
      "SELECT current_version FROM legal_documents WHERE code = 'cmpas_steps_terms'");
    expect(rows[0]?.current_version).toBeNull();
  });

  it("Т-6 Политика остаётся непринимаемой", async () => {
    const { rows } = await getPool().query<{ acceptance: string }>(
      "SELECT acceptance FROM legal_documents WHERE code = 'cmpas_privacy'");
    expect(rows[0]?.acceptance).toBe("none");
  });
});
