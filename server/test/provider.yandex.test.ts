import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createYandexAdapter, YANDEX_ENDPOINTS } from "../src/services/providers/yandex.js";

const CONFIG = {
  clientId: "yandex-client",
  clientSecret: "yandex-secret",
  redirectUri: "https://auth.cmpas.ru/callback/yandex",
};

/** Ответ Яндекса в том виде, в каком его описывает @auth/core. */
const PROFILE = {
  id: "1130000012345678",
  login: "ivan",
  default_email: "ivan@yandex.ru",
  emails: ["ivan@yandex.ru", "old@yandex.ru"],
  display_name: "Иван",
  real_name: "Иван Петров",
  first_name: "Иван",
  last_name: "Петров",
  sex: "male",
  birthday: "1990-01-01",
  default_avatar_id: "abc123",
  is_avatar_empty: false,
  default_phone: { id: 1, number: "+7999" },
};

function fakeFetch(handlers: {
  token?: unknown; profile?: unknown; tokenStatus?: number; profileStatus?: number;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(YANDEX_ENDPOINTS.token)) {
      return new Response(JSON.stringify(handlers.token ?? { access_token: "ya-at" }), {
        status: handlers.tokenStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(YANDEX_ENDPOINTS.userinfo)) {
      return new Response(JSON.stringify(handlers.profile ?? PROFILE), {
        status: handlers.profileStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("адрес авторизации Яндекса", () => {
  it("собирается из официальных адресов, а не из выдумки", () => {
    // Адреса взяты из @auth/core/providers/yandex.js — той библиотеки,
    // на которой уже работает вход в ПРАКТИКЕ.
    expect(YANDEX_ENDPOINTS.authorize).toBe("https://oauth.yandex.ru/authorize");
    expect(YANDEX_ENDPOINTS.token).toBe("https://oauth.yandex.ru/token");
    expect(YANDEX_ENDPOINTS.userinfo).toBe("https://login.yandex.ru/info");
  });

  it("несёт state и точный redirect_uri", () => {
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({}) });
    const url = new URL(a.authorizationUrl("state-1"));
    expect(url.origin + url.pathname).toBe(YANDEX_ENDPOINTS.authorize);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("yandex-client");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
  });

  it("не запрашивает аватар: мы его не показываем и не храним", () => {
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({}) });
    expect(a.authorizationUrl("s")).not.toContain("avatar");
  });
});

describe("обмен кода Яндекса", () => {
  it("код проверяется на сервере Яндекса, а не принимается на слово", async () => {
    const f = fakeFetch({});
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: f });
    await a.exchange("the-code");
    const calls = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]![0])).toBe(YANDEX_ENDPOINTS.token);
  });

  it("секрет уходит на сервер Яндекса, а не в адресную строку человека", async () => {
    const f = fakeFetch({});
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: f });
    await a.exchange("the-code");
    const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls[0]![1].method).toBe("POST");
    expect(String(calls[0]![1].body)).toContain("client_secret=yandex-secret");
    expect(a.authorizationUrl("s")).not.toContain("secret");
  });

  it("возвращает устойчивый идентификатор и почту", async () => {
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({}) });
    const identity = await a.exchange("code");
    expect(identity.subject).toBe("1130000012345678");
    expect(identity.email).toBe("ivan@yandex.ru");
  });

  it("НЕ возвращает ни ФИО, ни аватара, ни телефона", async () => {
    // CLAUDE.md: «Аватаров и ФИО из провайдера» — чего здесь не будет
    // никогда. Провайдер отдаёт больше, чем нам нужно; лишнее
    // выбрасывается сразу, а не хранится «на всякий случай».
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({}) });
    const identity = await a.exchange("code");
    const dump = JSON.stringify(identity);
    for (const leaked of ["Иван", "Петров", "abc123", "+7999", "male", "1990"]) {
      expect({ leaked, present: dump.includes(leaked) })
        .toEqual({ leaked, present: false });
    }
    expect(Object.keys(identity).sort()).toEqual(["email", "emailVerified", "subject"]);
  });

  it("аккаунт без почты даёт почту null — это ведёт на экран C2", async () => {
    const a = createYandexAdapter({
      ...CONFIG,
      fetchImpl: fakeFetch({ profile: { id: "1", default_email: null, emails: [] } }),
    });
    const identity = await a.exchange("code");
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it("берёт первую из emails, если основной нет", async () => {
    const a = createYandexAdapter({
      ...CONFIG,
      fetchImpl: fakeFetch({ profile: { id: "1", emails: ["fallback@yandex.ru"] } }),
    });
    expect((await a.exchange("code")).email).toBe("fallback@yandex.ru");
  });

  it("ответ без идентификатора отвергается, а не создаёт безымянную личность", async () => {
    const a = createYandexAdapter({
      ...CONFIG,
      fetchImpl: fakeFetch({ profile: { default_email: "x@ya.ru" } }),
    });
    await expect(a.exchange("code")).rejects.toThrow();
  });

  it("отказ Яндекса не проглатывается", async () => {
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({ tokenStatus: 400 }) });
    await expect(a.exchange("bad")).rejects.toThrow();
  });

  it("токен Яндекса после обмена не возвращается наружу", async () => {
    // §2.8 п. 4: токены провайдера не сохраняются.
    const a = createYandexAdapter({ ...CONFIG, fetchImpl: fakeFetch({}) });
    expect(JSON.stringify(await a.exchange("code"))).not.toContain("ya-at");
  });
});

describe("подключение Яндекса", () => {
  beforeEach(() => {
    delete process.env.YANDEX_CLIENT_ID;
    delete process.env.YANDEX_CLIENT_SECRET;
  });

  it("без ключей провайдер не подключается и на экране не появляется", async () => {
    const { yandexFromEnv } = await import("../src/services/providers/yandex.js");
    expect(yandexFromEnv()).toBeNull();
  });

  it("с ключами подключается", async () => {
    process.env.YANDEX_CLIENT_ID = "id";
    process.env.YANDEX_CLIENT_SECRET = "secret";
    const { yandexFromEnv } = await import("../src/services/providers/yandex.js");
    expect(yandexFromEnv()).not.toBeNull();
  });

  it("половины ключей недостаточно: молчаливо сломанный вход хуже отсутствующего", async () => {
    process.env.YANDEX_CLIENT_ID = "id";
    const { yandexFromEnv } = await import("../src/services/providers/yandex.js");
    expect(yandexFromEnv()).toBeNull();
  });
});
