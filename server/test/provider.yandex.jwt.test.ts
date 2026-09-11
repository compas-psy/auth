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

/**
 * Когда подпись сошлась, а личности в полезной нагрузке нет.
 *
 * Ровно этот случай подозревает агент ПРАКТИКИ (issue #27): если
 * настоящий JWT называет идентификатор `sub` или `psuid`, а не `id`,
 * снаружи это тот же `invalid_provider_code`, что и неверная подпись.
 *
 * Имена полей — не персональные данные: это ключи, а не значения. И
 * берутся они из ПРОВЕРЕННОГО подписью JWT, то есть от самого Яндекса,
 * а не от того, кто постучался. Значения не пишутся никуда никогда.
 *
 * Без этого разбор стоил бы ещё одного круга переписки: «пришлите
 * разобранный payload» — «вот ключи» — «а, у вас sub».
 */
describe("состав полей называется, когда личности в JWT нет", () => {
  it("ошибка несёт имена полей, но ни одного значения", async () => {
    const jwt = await подписать(
      { sub: "1234567890", default_email: "chelovek@yandex.ru", login: "chelovek" },
      SECRET,
    );
    const err = await адаптер().exchange({ jwt }).catch((e) => e);
    // exp и iat кладёт сама подпись — в настоящем JWT они тоже будут.
    expect((err as { claims?: string }).claims).toBe("default_email,exp,iat,login,sub");
    // Значения не попадают ни в поле, ни в текст.
    expect(JSON.stringify({ m: (err as Error).message, c: (err as { claims?: string }).claims }))
      .not.toMatch(/1234567890|chelovek@/);
  });

  it("у негодной подписи состав полей не называется вовсе", async () => {
    // Нагрузка непроверенного JWT — это то, что прислал стучащийся.
    // Пересказывать её в своём журнале мы не будем.
    const jwt = await подписать({ pridumano: "кем угодно" }, CHUZHOY);
    const err = await адаптер().exchange({ jwt }).catch((e) => e);
    expect((err as { claims?: string }).claims).toBeUndefined();
  });
});

/**
 * Настоящий JWT Яндекса называет поля иначе, чем справочник профиля.
 *
 * Состав, предъявленный боевым сервером 11.09.2026 (issue #27):
 * `display_name, email, exp, gender, iat, iss, jti, login, name,
 * phone, psuid, uid`.
 *
 * Подпись при этом СОШЛАСЬ — значит `getJwt` подписывает секретом
 * нашего приложения, и то «не проверено» снялось в хорошую сторону.
 * Не сошлись имена: `uid` вместо `id`, `email` вместо `default_email`.
 *
 * ── Почему `uid`, а не `psuid` ──────────────────────────────────────
 *
 * `psuid` — псевдоним, свой для каждого приложения. Взять его значит
 * выдать одному человеку РАЗНЫЕ личности в браузере и в приложении:
 * браузерный вход берёт `id` из `login.yandex.ru/info`, а это тот же
 * `uid`. Человек получил бы две учётные записи и не понял бы, почему
 * его записи пропали.
 *
 * Приватность псевдонима здесь проигрывает связности: у нас один
 * человек — одна учётная запись, это обещание сервиса.
 */
describe("состав полей настоящего JWT", () => {
  const НАСТОЯЩИЙ = {
    uid: "1234567890", psuid: "psuid-inoy-dlya-kazhdogo-prilozheniya",
    email: "chelovek@yandex.ru", login: "chelovek",
    display_name: "Человек", name: "Имя Фамилия", gender: "male",
    phone: "+70000000000", iss: "https://oauth.yandex.ru", jti: "x",
  };

  it("личность собирается из uid и email", async () => {
    const identity = await адаптер().exchange({ jwt: await подписать(НАСТОЯЩИЙ, SECRET) });
    expect(identity.subject).toBe("1234567890");
    expect(identity.email).toBe("chelovek@yandex.ru");
  });

  it("psuid не берётся: в браузере тот же человек придёт с uid", async () => {
    const identity = await адаптер().exchange({ jwt: await подписать(НАСТОЯЩИЙ, SECRET) });
    expect(identity.subject).not.toContain("psuid");
  });

  it("ФИО, пол и ТЕЛЕФОН не покидают разбор", async () => {
    // Телефон в нагрузке есть — и это ровно то, чего у нас не может
    // быть ни в одной колонке (И-2). Личность его не выносит.
    const identity = await адаптер().exchange({ jwt: await подписать(НАСТОЯЩИЙ, SECRET) });
    expect(JSON.stringify(identity)).not.toMatch(/\+7|Имя|male|Человек/);
    expect(Object.keys(identity).sort()).toEqual(["email", "emailVerified", "subject"]);
  });

  it("прежние имена тоже принимаются: браузерный путь не тронут", async () => {
    const identity = await адаптер().exchange({
      jwt: await подписать({ id: "42", default_email: "a@ya.ru" }, SECRET),
    });
    expect(identity.subject).toBe("42");
    expect(identity.email).toBe("a@ya.ru");
  });
});
