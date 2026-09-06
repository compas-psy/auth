import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildSite } from "../../devsite/src/build.ts";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient, issueTestToken } from "./helpers.js";
import { createAccountWithEmail } from "../src/services/accounts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVSITE = join(HERE, "../../devsite");

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  await buildSite({
    specPath: join(HERE, "../openapi/simpasid.v1.yaml"),
    outDir: join(DEVSITE, "dist"),
    changelogPath: join(HERE, "../../docs/CHANGELOG-api.md"),
  });
  app = await buildServer();
  await app.ready();
  const { accountId } = await createAccountWithEmail("dev@ya.ru");
  ({ token } = await issueTestToken(accountId));
});
afterAll(async () => { await app.close(); await closePool(); });

/** Достаёт первый пример curl со страницы. */
function extractCurl(html: string): string {
  const m = /<pre>(curl[\s\S]*?)<\/pre>/.exec(html);
  if (!m) throw new Error("на титульной нет примера curl");
  return m[1]!
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Разбирает пример в запрос к нашему же серверу. */
function toRequest(snippet: string): { method: string; url: string } {
  const line = snippet.replace(/\\\n\s*/g, " ");
  const url = /https:\/\/auth\.cmpas\.ru(\/v1\S*)/.exec(line)?.[1];
  if (!url) throw new Error(`в примере нет адреса нашего API: ${line}`);
  const method = /-X\s+([A-Z]+)/.exec(line)?.[1] ?? "GET";
  return { method, url };
}

describe("ресурс разработчика: пример не протухает незаметно", () => {
  it("пример первого запроса на титульной исполняется и возвращает 200", async () => {
    const html = readFileSync(join(DEVSITE, "dist/index.html"), "utf8");
    const { method, url } = toRequest(extractCurl(html));
    const r = await app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect({ url, code: r.statusCode }).toEqual({ url, code: 200 });
  });

  it("тот же пример без ключа отвечает 401, а не 404: ручка существует", async () => {
    const html = readFileSync(join(DEVSITE, "dist/index.html"), "utf8");
    const { url } = toRequest(extractCurl(html));
    expect((await app.inject({ url })).statusCode).toBe(401);
  });

  it("ответ, показанный на титульной, совпадает по составу полей с настоящим", async () => {
    const html = readFileSync(join(DEVSITE, "dist/index.html"), "utf8");
    const shown = /<h3>Ответ<\/h3>\s*<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
    expect(shown).toBeTruthy();
    const promised = Object.keys(JSON.parse(
      shown!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
    const { url } = toRequest(extractCurl(html));
    const real = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    for (const field of promised) {
      expect({ field, present: field in real.json() }).toEqual({ field, present: true });
    }
  });

  it("каждый пример curl в справочнике адресован существующей ручке", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = join(DEVSITE, "dist/reference");
    for (const file of readdirSync(dir)) {
      const html = readFileSync(join(dir, file), "utf8");
      const { method, url } = toRequest(extractCurl(html));
      const r = await app.inject({
        method: method as "GET",
        url: url.replace(/<[^>]+>/g, "00000000-0000-0000-0000-000000000000"),
        headers: { authorization: `Bearer ${token}`, "x-client-id": "practice-mobile" },
      });
      // Отличаем «такого маршрута нет» от «такой записи нет»: второе
      // законно (подставлен несуществующий идентификатор), первое
      // означает, что справочник обещает несуществующую ручку.
      const routeMissing =
        r.statusCode === 404 && /Route .* not found/i.test(r.body);
      expect({ file, routeMissing }).toEqual({ file, routeMissing: false });
    }
  });
});
