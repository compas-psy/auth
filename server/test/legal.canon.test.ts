import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { getPool, closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";

/**
 * Приёмка юридического контура — 13_LEGAL_CONSENT_CENTER_AUTH.md §8.
 *
 * Каждый пункт приёмки здесь отдельной проверкой. Реестр документов —
 * вещь, которую невозможно проверить взглядом: расхождение между ним и
 * тем, что открывается по адресу, обнаруживается юристом в споре, а не
 * разработчиком на экране.
 */

let app: FastifyInstance;
let textsDir: string;

/**
 * Редакция, у которой текст ПОЛОЖЕН: мерило механики публикации.
 *
 * Документ СВОЙ, а не настоящий. Первая редакция этой проверки брала
 * `cmpas_moments_terms` — и публиковала под настоящим кодом пробный
 * текст. В общей тестовой базе оставался поддельный отпечаток, а
 * поскольку опубликованный отпечаток неизменяем (0014), настоящий
 * текст МОМЕНТОВ потом не публиковался вовсе: защита честно видела
 * расхождение. Поймано на живой поставке текстов 11.09.2026.
 */
const FIXTURE = { code: "fixture_terms", version: "9.9", body: "# Особые условия\n\nПробный текст.\n" };
const FIXTURE_HASH = createHash("sha256").update(FIXTURE.body, "utf8").digest("hex");

beforeAll(async () => {
  await ensureSchema();
  // Свой документ заводится здесь же: реестр настоящих документов
  // проверка не трогает.
  await getPool().query(
    `INSERT INTO legal_documents (code, title, acceptance, current_version)
     VALUES ($1, 'Проба механики публикации', 'action', $2)
     ON CONFLICT (code) DO NOTHING`, [FIXTURE.code, FIXTURE.version]);
  await getPool().query(
    `INSERT INTO legal_document_versions
       (code, version, effective_at, content_hash, immutable_url)
     VALUES ($1, $2, '2026-09-03T00:00:00Z', 'PENDING', $3)
     ON CONFLICT (code, version) DO NOTHING`,
    [FIXTURE.code, FIXTURE.version, `/legal/fixture-terms/${FIXTURE.version}`]);
  textsDir = mkdtempSync(join(tmpdir(), "simpasid-legal-"));
  mkdirSync(join(textsDir, FIXTURE.code), { recursive: true });
  writeFileSync(join(textsDir, FIXTURE.code, `${FIXTURE.version}.md`), FIXTURE.body, "utf8");
  process.env.LEGAL_TEXTS_DIR = textsDir;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePool();
  rmSync(textsDir, { recursive: true, force: true });
  delete process.env.LEGAL_TEXTS_DIR;
});

describe("§8.1 центральный текст открывается на нашем домене", () => {
  it("ни одна редакция не отправляет за текстом на домен продукта", async () => {
    const { rows } = await getPool().query<{ immutable_url: string }>(
      "SELECT immutable_url FROM legal_document_versions");
    for (const { immutable_url } of rows) {
      const r = await app.inject({ url: immutable_url });
      // Именно cmpas.ru: ссылка на домен ПРАКТИКИ — это и есть Д-1.
      expect({ immutable_url, ушлоНаПродукт: /https:\/\/cmpas\.ru/.test(r.body) })
        .toEqual({ immutable_url, ушлоНаПродукт: false });
    }
  });

  it("текст выложенной редакции виден прямо на странице", async () => {
    const r = await app.inject({ url: "/legal/fixture-terms/9.9" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Пробный текст.");
  });

  it("исходник, по которому считается отпечаток, отдаётся как есть", async () => {
    const r = await app.inject({ url: "/legal/fixture-terms/9.9.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toBe(FIXTURE.body);
    expect(createHash("sha256").update(r.body, "utf8").digest("hex")).toBe(FIXTURE_HASH);
  });
});

describe("§8.2 и §5.2 отпечаток", () => {
  it("отпечаток берётся из текста, а не вписывается руками", async () => {
    const { rows } = await getPool().query<{ content_hash: string }>(
      "SELECT content_hash FROM legal_document_versions WHERE code=$1 AND version=$2",
      [FIXTURE.code, FIXTURE.version]);
    expect(rows[0]?.content_hash).toBe(FIXTURE_HASH);
  });

  it("у редакции без текста отпечаток честно не подтверждён", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toContain("не подтверждён");
  });

  it("опубликованный отпечаток база менять не даёт", async () => {
    await expect(getPool().query(
      "UPDATE legal_document_versions SET content_hash='ПОДМЕНА' WHERE code=$1 AND version=$2",
      [FIXTURE.code, FIXTURE.version],
    )).rejects.toThrow();
  });

  it("опубликованную редакцию база не даёт удалить", async () => {
    await expect(getPool().query(
      "DELETE FROM legal_document_versions WHERE code=$1 AND version=$2",
      [FIXTURE.code, FIXTURE.version],
    )).rejects.toThrow();
  });
});

describe("§8.3 реестр сервисов", () => {
  it("открывается", async () => {
    const r = await app.inject({ url: "/legal/services" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("перечисляет все сервисы экосистемы", async () => {
    const r = await app.inject({ url: "/legal/services" });
    for (const name of ["ПРАКТИКА", "ЗАПИСКИ", "МОМЕНТЫ", "ШАГИ"]) {
      expect({ name, есть: r.body.includes(name) }).toEqual({ name, есть: true });
    }
  });

  it("у каждого сервиса названы состояние и ссылка на Особые условия", async () => {
    const r = await app.inject({ url: "/legal/services" });
    expect(r.body).toContain("/legal/practice-terms");
    expect(r.body).toContain("/legal/notes-terms");
    // ШАГИ — сервиса ещё нет, и ссылке вести некуда.
    expect(r.body).toContain("готовится");
  });
});

describe("§8.4 реестр обработчиков", () => {
  it("открывается и перечисляет категории", async () => {
    const r = await app.inject({ url: "/legal/processors" });
    expect(r.statusCode).toBe(200);
    for (const category of ["Хостинг", "Доставка писем", "Вход через провайдеров"]) {
      expect({ category, есть: r.body.includes(category) }).toEqual({ category, есть: true });
    }
  });

  it("не называет ни одного обработчика поимённо до подтверждения", async () => {
    // §5.5: «с этим обработчиком у нас оформлено поручение» — заявление
    // проверяемое, и ошибиться в нём нельзя.
    const r = await app.inject({ url: "/legal/processors" });
    for (const named of ["Т-Банк", "DaData", "ЮKassa", "FingerprintJS", "Метрика"]) {
      expect({ named, названПоимённо: r.body.includes(named) })
        .toEqual({ named, названПоимённо: false });
    }
  });
});

describe("§8.5 сервис без Особых условий не подключается", () => {
  it("отказ приходит от сервера, а не прячется в интерфейсе", async () => {
    const { linkProduct } = await import("../src/services/accounts.js");
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO accounts DEFAULT VALUES RETURNING id");
    const accountId = rows[0]!.id;
    await expect(linkProduct(accountId, "steps", "u-1")).rejects.toThrow(/steps/);
    const linked = await getPool().query(
      "SELECT 1 FROM product_links WHERE account_id=$1", [accountId]);
    expect(linked.rows.length).toBe(0);
  });

  it("сервис с опубликованными условиями подключается как прежде", async () => {
    const { linkProduct } = await import("../src/services/accounts.js");
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO accounts DEFAULT VALUES RETURNING id");
    await linkProduct(rows[0]!.id, "moments", "u-2");
    const linked = await getPool().query(
      "SELECT 1 FROM product_links WHERE account_id=$1", [rows[0]!.id]);
    expect(linked.rows.length).toBe(1);
  });
});

describe("§8.6 Политика не принимается", () => {
  it("на странице сказано, что принимать её не нужно", async () => {
    const r = await app.inject({ url: "/legal/privacy/0.9" });
    expect(r.body).toContain("Это информационный документ");
  });

  it("на странице нет ни кнопки принятия, ни чекбокса", async () => {
    const r = await app.inject({ url: "/legal/privacy/0.9" });
    expect(r.body).not.toMatch(/<button|type="checkbox"|<form/);
  });

  it("в реестре она помечена как непринимаемая", async () => {
    const { rows } = await getPool().query<{ acceptance: string }>(
      "SELECT acceptance FROM legal_documents WHERE code='cmpas_privacy'");
    expect(rows[0]?.acceptance).toBe("none");
  });
});

describe("§8.7 второй политики нет ни у одного сервиса", () => {
  it("в реестре нет документа с названием «Политика …» кроме центральной", async () => {
    const { rows } = await getPool().query<{ code: string; title: string }>(
      "SELECT code, title FROM legal_documents WHERE title ILIKE '%политик%'");
    expect(rows.map((r) => r.code)).toEqual(["cmpas_privacy"]);
  });
});

describe("§8.9 и §5.6 канон страницы редакции", () => {
  it("страница называет код, редакцию и дату вступления", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toContain("cmpas_terms");
    expect(r.body).toContain("редакция 0.9");
    expect(r.body).toContain("3 сентября 2026");
  });

  it("на странице есть ссылка на перечень редакций этого документа", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toContain('href="/legal/terms"');
  });

  it("перечень редакций открывается и называет действующую", async () => {
    const r = await app.inject({ url: "/legal/terms" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("0.9");
    expect(r.body).toContain("действующая");
  });
});

describe("§8.10 реестр документов и реестр сервисов сходятся", () => {
  it("у каждого сервиса есть свои Особые условия", async () => {
    const { PRODUCTS } = await import("../src/services/accounts.js");
    const { rows } = await getPool().query<{ product: string }>(
      "SELECT product FROM legal_documents WHERE product IS NOT NULL");
    expect(rows.map((r) => r.product).sort()).toEqual([...PRODUCTS].sort());
  });

  it("у сервиса не может быть двух Особых условий", async () => {
    // Проверяется базой, а не внимательностью: вторые условия того же
    // сервиса — это два разных договора об одном и том же.
    await expect(getPool().query(
      `INSERT INTO legal_documents (code, title, acceptance, product)
       VALUES ('дубль_условий','Вторые условия ПРАКТИКИ','action','practice')`,
    )).rejects.toThrow();
  });

  it("центральные документы ни к какому сервису не привязаны", async () => {
    // Пользовательское соглашение, Политика и рекламное согласие —
    // документы Экосистемы. Привязать их к продукту значило бы
    // завести вторую политику окольным путём (§3, §7.6).
    const { rows } = await getPool().query<{ code: string }>(
      `SELECT code FROM legal_documents
       WHERE product IS NOT NULL
         AND code IN ('cmpas_terms','cmpas_privacy','cmpas_marketing_consent',
                      'cmpas_professional')`);
    expect(rows.map((r) => r.code)).toEqual([]);
  });
});

describe("продукту есть откуда узнать действующую редакцию", () => {
  /**
   * 14_LEGAL_PRODUCTS_UNIFIED.md §4: продукт показывает строку
   * «Начиная работу, вы принимаете Особые условия ПРАКТИКИ, редакция
   * 1.0» и ссылку на КОНКРЕТНУЮ редакцию.
   *
   * Взять номер редакции было неоткуда: `GET /v1/account/consents`
   * отдаёт только УЖЕ принятые документы, а редакция меняется без
   * выпуска новой сборки приложения. Продукту оставалось вписать
   * номер руками — то есть однажды предъявить человеку не ту
   * редакцию, которую он принимает.
   */
  it("перечень документов открыт без входа: это публичные документы", async () => {
    const r = await app.inject({ url: "/v1/legal/documents" });
    expect(r.statusCode).toBe(200);
  });

  it("называет код, редакцию, название и неизменяемый адрес", async () => {
    const r = await app.inject({ url: "/v1/legal/documents" });
    const body = r.json() as { documents: Array<Record<string, unknown>> };
    const terms = body.documents.find((d) => d.document_code === "cmpas_terms");
    expect(terms).toMatchObject({
      document_code: "cmpas_terms",
      title: "Пользовательское соглашение СИМПАС",
      version: "0.9",
      url: "/legal/terms/0.9",
      acceptance: "action",
    });
  });

  it("говорит, к какому сервису относятся Особые условия", async () => {
    const r = await app.inject({ url: "/v1/legal/documents" });
    const body = r.json() as { documents: Array<Record<string, unknown>> };
    const practice = body.documents.find((d) => d.product === "practice");
    expect(practice?.document_code).toBe("cmpas_practice_terms");
  });

  it("документа без опубликованной редакции в перечне нет", async () => {
    // ШАГИ: продукт есть, Особых условий нет. Их отсутствие здесь —
    // и есть ответ продукту «подключать нечего».
    const r = await app.inject({ url: "/v1/legal/documents" });
    const body = r.json() as { documents: Array<{ document_code: string }> };
    expect(body.documents.map((d) => d.document_code)).not.toContain("cmpas_steps_terms");
  });

  it("Политика в перечне есть и помечена непринимаемой", async () => {
    // Продукт обязан дать на неё ссылку и обязан НЕ давать её принять.
    const r = await app.inject({ url: "/v1/legal/documents" });
    const body = r.json() as { documents: Array<Record<string, unknown>> };
    const privacy = body.documents.find((d) => d.document_code === "cmpas_privacy");
    expect(privacy?.acceptance).toBe("none");
  });
});
