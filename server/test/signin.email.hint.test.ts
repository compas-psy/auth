import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";

/**
 * Подсказка почты в запросе авторизации — штатный `login_hint` OIDC.
 *
 * Зачем. У ПРАКТИКИ на экране входа своё поле почты, и после переезда
 * на единый вход человек набирал бы адрес дважды: у них и у нас.
 * Мелочь, из-за которой продукт цепляется за собственную форму входа —
 * а собственная форма входа означает учётную запись, заведённую мимо
 * нашего экрана, то есть мимо акцепта Пользовательского соглашения.
 * Так что это не удобство, а то, что делает переезд возможным.
 *
 * `login_hint` — параметр самой спецификации, регистрировать его в
 * `extraParams` не требуется: он приходит в `oidc.params` и
 * пробрасывается стандартным Prompt'ом `login` (сверено с
 * документацией `oidc-provider` через `context7`).
 *
 * Подсказка НИЧЕГО НЕ ПОДТВЕРЖДАЕТ. Подставленный адрес — это
 * заполненное поле, не более: код или ссылка всё равно уходят в этот
 * ящик. Поэтому параметром можно безопасно пользоваться из ссылки, а
 * ответ сервиса на «есть такой адрес или нет» остаётся одинаковым.
 */
let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

function authUrl(extra: Record<string, string> = {}): string {
  return "/oidc/auth?" + new URLSearchParams({
    client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
    scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "st", nonce: "nc", ...extra,
  });
}

async function screenFor(extra: Record<string, string> = {}) {
  const start = await app.inject({ url: authUrl(extra), headers: HOST });
  const raw = start.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [String(raw ?? "")])
    .map((c) => c.split(";")[0]).join("; ");
  const uid = String(start.headers.location).replace("/interaction/", "");
  const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie } });
  const json = /<script id="state" type="application\/json">(.*?)<\/script>/s.exec(r.body)![1]!;
  return { response: r, state: JSON.parse(json.replace(/\\u003c/g, "<")) };
}

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  const { buildServer } = await import("../src/index.js");
  app = await buildServer();
  await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

describe("подсказка почты", () => {
  it("названный адрес приходит на экран подставленным", async () => {
    const { state } = await screenFor({ login_hint: "chelovek@cmpas.ru" });
    expect(state.emailHint).toBe("chelovek@cmpas.ru");
  });

  it("без подсказки поле пустое, как и было", async () => {
    const { state } = await screenFor();
    expect(state.emailHint).toBeUndefined();
  });

  it("подсказка едет в состоянии, а не в разметке заглушки", async () => {
    // Серверная разметка SignIn — заглушка до загрузки скрипта: поля
    // почты в ней нет вовсе, форму рисует портал. Первая редакция этой
    // проверки искала value="…" в разметке и закрепляла то, чего на
    // экране не существует. Подстановку в поле проверяет портал
    // (portal/test/signin.spec.tsx), здесь — что значение доехало.
    const { response, state } = await screenFor({ login_hint: "chelovek@cmpas.ru" });
    expect(state.emailHint).toBe("chelovek@cmpas.ru");
    expect(response.statusCode).toBe(200);
  });

  it("не похожее на адрес игнорируется молча", async () => {
    // Отказ входа из-за опечатки в ЧУЖОЙ ссылке — плохая сделка:
    // подсказка необязательна, и её негодность не повод не пускать.
    const { response, state } = await screenFor({ login_hint: "не адрес вовсе" });
    expect(state.emailHint).toBeUndefined();
    expect(response.statusCode).toBe(200);
  });

  it("разметка не ломается подсказкой с кавычками и тегом", async () => {
    const ЯД = '"><script>alert(1)</script>@x.ru';
    const { response } = await screenFor({ login_hint: ЯД });
    expect(response.body).not.toContain("<script>alert(1)</script>");
  });

  it("слишком длинная подсказка не принимается", async () => {
    const { state } = await screenFor({ login_hint: "a".repeat(300) + "@cmpas.ru" });
    expect(state.emailHint).toBeUndefined();
  });

  it("экран остаётся прежним: подсказка не пропускает шаг входа", async () => {
    // Подставленный адрес — не вход. Человек всё равно нажимает кнопку,
    // и юридическая строка на месте: акцепт берётся здесь.
    const { response } = await screenFor({ login_hint: "chelovek@cmpas.ru" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-testid="legal-line"');
  });
});
