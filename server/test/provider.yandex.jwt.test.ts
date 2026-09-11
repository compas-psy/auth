import { describe, it, expect, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { createYandexNativeAdapter } from "../src/services/providers/yandex.js";

/**
 * Нативный Яндекс на Android отдаёт не код, а ТОКЕН.
 *
 * 11.09.2026 агент ПРАКТИКИ прочитал публичный API артефакта
 * `com.yandex.android:authsdk:3.2.1` и предъявил: результат входа —
 * `YandexAuthResult.Success(YandexAuthToken)`, типа результата с кодом
 * авторизации в SDK нет вовсе. Наш адаптер ждал код — то есть нативный
 * вход через Яндекс не прошёл бы ни разу.
 *
 * ── Почему JWT, а не сам токен ──────────────────────────────────────
 *
 * Принять голый `access_token` значит принять чужой. Токен, выданный
 * ДРУГОМУ приложению Яндекса, к `login.yandex.ru/info` подходит так же,
 * как наш: у ответа нет поля «кому выдан». Злоумышленник, заманивший
 * человека в своё приложение, предъявил бы нам его токен и вошёл бы
 * ЕГО учётной записью. Это подмена токена — то, ради чего в OIDC
 * вообще появился `id_token`.
 *
 * JWT закрывает это подписью: Яндекс подписывает его секретным ключом
 * ПРИЛОЖЕНИЯ (HS256), а секрет нашего приложения лежит только у нас.
 * JWT, выпущенный для чужого приложения, подписан чужим секретом и
 * нашу проверку не проходит.
 *
 * **НЕ ПРОВЕРЕНО:** что `YandexAuthSdk.getJwt(token)` отдаёт JWT,
 * подписанный именно секретом нашего приложения, и что состав полей
 * совпадает с ответом `login.yandex.ru/info`. Документация Яндекса
 * (`yandex.ru/dev/id/doc/ru/tokens/jwt`) описывает подпись HS256
 * секретным ключом приложения для `format=jwt`; про SDK там прямо не
 * сказано, а сам адрес из этой среды недоступен. Способ проверки —
 * первый живой вход: несовпадение даёт отказ, а не тихий вход.
 */

afterEach(() => vi.unstubAllEnvs());

const SECRET = "sekret-nashego-prilozheniya-dlinoyu-bolshe-tridcati";
const CHUZHOY = "sekret-chuzhogo-prilozheniya-takoy-zhe-dlinnyy-";

const ЛИЧНОСТЬ = { id: "1234567890", default_email: "chelovek@yandex.ru" };

function адаптер(secret = SECRET) {
  return createYandexNativeAdapter({
    clientId: "nashe-prilozhenie",
    clientSecret: secret,
    // Сеть в этих проверках не нужна вовсе: JWT проверяется у нас.
    // Обращение к Яндексу означало бы, что подпись ничего не решает.
    fetchImpl: (() => {
      throw new Error("к Яндексу ходить не должны: личность уже в подписанном JWT");
    }) as unknown as typeof fetch,
  });
}

async function подписать(payload: object, secret: string, expires = "5m") {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(secret));
}

describe("Яндекс: личность из подписанного JWT", () => {
  it("проверяется нашим секретом и отдаёт идентификатор и почту", async () => {
    const jwt = await подписать(ЛИЧНОСТЬ, SECRET);
    const identity = await адаптер().exchange({ jwt });
    expect(identity.subject).toBe("1234567890");
    expect(identity.email).toBe("chelovek@yandex.ru");
  });

  it("к Яндексу за профилем не ходит: всё уже в подписи", async () => {
    // fetchImpl бросает. Если проверка позеленела — сети не было.
    const jwt = await подписать(ЛИЧНОСТЬ, SECRET);
    await expect(адаптер().exchange({ jwt })).resolves.toBeTruthy();
  });

  it("ПОДМЕНА: JWT чужого приложения не принимается", async () => {
    const jwt = await подписать(ЛИЧНОСТЬ, CHUZHOY);
    await expect(адаптер().exchange({ jwt })).rejects.toThrow();
  });

  it("просроченный JWT не принимается", async () => {
    const jwt = await подписать(ЛИЧНОСТЬ, SECRET, "-1s");
    await expect(адаптер().exchange({ jwt })).rejects.toThrow();
  });

  it("JWT без идентификатора не принимается", async () => {
    const jwt = await подписать({ default_email: "x@ya.ru" }, SECRET);
    await expect(адаптер().exchange({ jwt })).rejects.toThrow();
  });

  it("подделка с alg: none не принимается", async () => {
    // Классическая дыра проверяющих JWT: доверять заголовку.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(ЛИЧНОСТЬ)).toString("base64url");
    await expect(адаптер().exchange({ jwt: `${header}.${body}.` })).rejects.toThrow();
  });

  it("ни кода, ни JWT — отказ, а не попытка угадать", async () => {
    await expect(адаптер().exchange({})).rejects.toThrow();
  });
});
