import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPool } from "../db/pool.js";
import { logger } from "../lib/logging.js";

/**
 * Тексты юридических документов — файлами в репозитории.
 *
 * ── Почему не на домене продукта ────────────────────────────────────
 *
 * Полный текст центральных документов лежал на cmpas.ru, и правка в
 * репозитории ПРАКТИКИ меняла документ, который приняли пользователи
 * всех сервисов (ТЗ §1 Д-1). Центральный документ Экосистемы хранится
 * и отдаётся консент-центром; продукт на него только ссылается.
 *
 * ── Почему файлами, а не строкой в базе ─────────────────────────────
 *
 * Отпечаток редакции обязан быть отпечатком ТОГО, что человек видел.
 * Хеш, вписанный руками рядом с текстом, доказывает только аккуратность
 * вписавшего. Здесь он считается из байтов файла, и те же байты
 * отдаются по адресу `<адрес редакции>.txt` — проверить совпадение
 * может кто угодно, не имея доступа к базе.
 *
 * Правка файла опубликованной редакции не пройдёт: база держит
 * отпечаток неизменным (0014), а несовпадение видно и в журнале, и на
 * самой странице. Изменившийся текст — это новая редакция, а не правка
 * старой (§7.4).
 */
const DEFAULT_DIR = "/app/legal";

export function legalTextsDir(): string {
  return resolve(process.env.LEGAL_TEXTS_DIR ?? DEFAULT_DIR);
}

/** Редакции, чей файл разошёлся с опубликованным отпечатком. */
const tampered = new Set<string>();

export function isTampered(code: string, version: string): boolean {
  return tampered.has(`${code}@${version}`);
}

export interface LegalText {
  source: string;
  hash: string;
}

/**
 * Текст редакции, если он положен в репозиторий.
 *
 * Код и версия приходят ИЗ РЕЕСТРА, а не из адреса, набранного
 * человеком: путь, собранный из пользовательского ввода, — это обход
 * каталогов. На всякий случай состав знаков проверяется и здесь:
 * защита в одном месте держится ровно до первого нового вызова.
 */
export function readLegalText(code: string, version: string): LegalText | null {
  if (!/^[a-z0-9_]+$/.test(code) || !/^[0-9]+(\.[0-9]+)*$/.test(version)) return null;
  const file = join(legalTextsDir(), code, `${version}.md`);
  if (!existsSync(file)) return null;
  const source = readFileSync(file, "utf8");
  return { source, hash: createHash("sha256").update(source, "utf8").digest("hex") };
}

/**
 * Публикация текстов при запуске.
 *
 * Редакция с текстом и отпечатком PENDING получает настоящий
 * отпечаток — это и есть момент публикации. Редакция, у которой
 * отпечаток уже стоит, сверяется: расхождение означает, что текст
 * правили после публикации, и об этом надо кричать, а не молчать.
 *
 * Сервис при расхождении НЕ падает. Вход — дверь всей экосистемы, и
 * ронять её из-за правки юридического файла нельзя (Р-1). Вместо
 * этого текст такой редакции не показывается вовсе, а страница
 * говорит, почему.
 */
export async function publishLegalTexts(): Promise<void> {
  const { rows } = await getPool().query<{ code: string; version: string; content_hash: string }>(
    "SELECT code, version, content_hash FROM legal_document_versions");

  const published: string[] = [];
  for (const row of rows) {
    const text = readLegalText(row.code, row.version);
    if (!text) continue;
    if (row.content_hash === "PENDING") {
      await getPool().query(
        "UPDATE legal_document_versions SET content_hash = $3 WHERE code = $1 AND version = $2",
        [row.code, row.version, text.hash],
      );
      published.push(`${row.code}@${row.version}`);
      continue;
    }
    if (row.content_hash !== text.hash) {
      // Ни кода документа, ни текста: в журнал идёт то, что нужно для
      // разбора, и ничего сверх.
      logger.error({
        event: "legal_text_mismatch", code: row.code, version: row.version,
      });
      tampered.add(`${row.code}@${row.version}`);
    }
  }
  if (published.length) logger.info({ event: "legal_texts_published", versions: published });
}
