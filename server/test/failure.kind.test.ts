import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { failureKind } from "../src/lib/logging.js";

/**
 * Отказ обязан НАЗЫВАТЬ СВОЙ РОД.
 *
 * Сегодня при 500 в журнал уходит только код состояния. Человеку
 * показывается «Вход временно недоступен» — и это верно, техническая
 * ошибка на экране входа недопустима. Но и разбирающему не остаётся
 * ничего: ни рода отказа, ни хотя бы того, база это или код.
 *
 * Случилось ровно это: единый вход стал дверью по умолчанию для
 * ПРАКТИКИ, вход через Яндекс упал на боевом, и сервер не мог сказать
 * почему. Молчание журнала стоило часа догадок.
 *
 * Род отказа — это имя класса ошибки и код ошибки Postgres. Ни то, ни
 * другое человека не опознаёт: «TypeError» и «23505» — не персональные
 * данные, в отличие от текста сообщения, где едут адреса и пути.
 */

let app: FastifyInstance;

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  app = await buildServer();
  await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

describe("род отказа", () => {
  it("имя класса ошибки называется", () => {
    expect(failureKind(new TypeError("нельзя читать поле у undefined")))
      .toBe("TypeError");
  });

  it("у ошибки базы называется её код, а не текст", () => {
    const pgError = Object.assign(new Error("duplicate key value violates …"), {
      code: "23505", name: "error",
    });
    expect(failureKind(pgError)).toBe("error/23505");
  });

  it("не переносит в журнал ни текст сообщения, ни стек", () => {
    // В тексте ошибки едут адреса, пути и значения полей: «duplicate
    // key … Key (email)=(ivan@ya.ru) already exists» — это утечка.
    const kind = failureKind(new Error("сбой у ivan@ya.ru по пути /v1/account"));
    expect(kind).not.toContain("ivan@ya.ru");
    expect(kind).not.toContain("/v1/account");
  });

  it("не падает на том, что ошибкой не является", () => {
    // throw "строка" — законный JavaScript, и обработчик отказов не
    // имеет права упасть сам.
    expect(failureKind("просто строка")).toBe("unknown");
    expect(failureKind(null)).toBe("unknown");
  });

  it("экран отказа человеку по-прежнему без техники", async () => {
    const r = await app.inject({
      url: "/oidc/interaction/несуществующая",
      headers: { accept: "text/html" },
    });
    expect(r.body).not.toContain("Error");
    expect(r.body).not.toContain("stack");
  });
});
