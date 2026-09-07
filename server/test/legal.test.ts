import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { getPool, closePool } from "../src/db/pool.js";
import { ensureSchema } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => { await ensureSchema(); app = await buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); await closePool(); });

describe("неизменяемые адреса документов", () => {
  it("адрес, на который ссылается экран входа, отдаёт страницу, а не 404", async () => {
    // Ровно тот адрес, который стоит в юридической строке.
    for (const url of ["/legal/terms/0.9", "/legal/privacy/0.9"]) {
      const r = await app.inject({ url });
      expect({ url, code: r.statusCode }).toEqual({ url, code: 200 });
      expect(r.headers["content-type"]).toContain("text/html");
    }
  });

  it("каждый адрес из реестра документов обслуживается", async () => {
    // Реестр — источник истины: если в нём есть редакция, её адрес
    // обязан открываться. Иначе человек, принявший документ, не сможет
    // посмотреть, что именно он принял.
    const { rows } = await getPool().query<{ immutable_url: string }>(
      "SELECT immutable_url FROM legal_document_versions");
    expect(rows.length).toBeGreaterThan(0);
    for (const { immutable_url } of rows) {
      const r = await app.inject({ url: immutable_url });
      expect({ immutable_url, code: r.statusCode }).toEqual({ immutable_url, code: 200 });
    }
  });

  it("страница называет документ и КОНКРЕТНУЮ редакцию", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toContain("Пользовательское соглашение СИМПАС");
    expect(r.body).toContain("редакция 0.9");
  });

  it("несуществующая редакция даёт 404, а не чужой документ", async () => {
    // Подмена редакции — это подмена того, что человек принял.
    const r = await app.inject({ url: "/legal/terms/99.0" });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("редакция 0.9");
  });

  it("неизвестный документ даёт 404", async () => {
    expect((await app.inject({ url: "/legal/nothing/1.0" })).statusCode).toBe(404);
  });

  it("страница документа отдаётся только по адресу из реестра", async () => {
    // Проверяется не код ответа, а суть: страницу документа нельзя
    // получить ни по какому адресу, кроме записанного в реестре.
    // (/legal/../x маршрутизатор приводит к /x ещё до нашего обработчика
    // и отдаёт то, что там лежит, — это не обход, а нормализация пути.)
    const { rows } = await getPool().query<{ immutable_url: string }>(
      "SELECT immutable_url FROM legal_document_versions");
    const known = new Set(rows.map((r) => r.immutable_url));

    // «/legal/terms/0.9/../0.9» сюда не входит намеренно: маршрутизатор
    // приводит его к каноническому /legal/terms/0.9 ещё до обработчика,
    // и отдать там тот же документ — правильно, а не дыра.
    for (const url of [
      "/legal/terms/..%2fprivacy%2f0.9",
      "/legal/terms", "/legal/terms/", "/legal/TERMS/0.9", "/legal//terms/0.9",
    ]) {
      const r = await app.inject({ url });
      const servesDocument = r.statusCode === 200 && r.body.includes("Документ СИМПАС");
      expect({ url, servesDocument: servesDocument && !known.has(url) })
        .toEqual({ url, servesDocument: false });
    }
  });

  it("страница ведёт к опубликованному тексту", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toContain("https://cmpas.ru/legal/terms");
  });

  it("честно сообщает, что хеш текста ещё не подтверждён", async () => {
    // content_hash = PENDING: текст в сервис ещё не опубликован.
    // Молчать об этом нельзя — доказательством согласия служит связка
    // «редакция + хеш того, что человек видел».
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(r.body).toMatch(/не подтверждён|PENDING/i);
  });

  it("страница документа кэшируется: редакция неизменяема по определению", async () => {
    const r = await app.inject({ url: "/legal/terms/0.9" });
    expect(String(r.headers["cache-control"])).toMatch(/max-age|immutable/);
  });

  it("на странице нет запрещённых на экранах слов", async () => {
    const r = await app.inject({ url: "/legal/privacy/0.9" });
    for (const w of ["OAuth", "OIDC", "SimpasID", "токен"]) {
      expect(r.body.toLowerCase()).not.toContain(w.toLowerCase());
    }
  });
});
