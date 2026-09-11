import { describe, it, expect, afterEach, vi } from "vitest";
import { clearNativeAdapters, availableProviders, nativeAdapterFor,
  connectNativeProviders } from "../src/services/providers/native.js";
import { createVkidNativeAdapter } from "../src/services/providers/vkid.js";
import { createYandexNativeAdapter } from "../src/services/providers/yandex.js";
import { VKID_ENDPOINTS } from "../src/services/providers/vkid.js";
import { YANDEX_ENDPOINTS } from "../src/services/providers/yandex.js";

/**
 * Нативный вход через провайдера: приложение получает код от SDK
 * провайдера, отдаёт код нам, личность собирает СЕРВЕР.
 *
 * Почему это не то же самое, что веб-адаптер: в браузерном входе
 * авторизацию начинаем МЫ и потому знаем state и проверочный код
 * PKCE. В нативном её начинает приложение, и эти значения знает
 * только оно — значит они обязаны приехать вместе с кодом.
 */

afterEach(() => {
  clearNativeAdapters();
  vi.unstubAllEnvs();
});

const OK = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("VK ID: нативный обмен", () => {
  it("шлёт VK всё, чего он требует, включая проверочный код приложения", async () => {
    const sent: URLSearchParams[] = [];
    const adapter = createVkidNativeAdapter({
      clientId: "53814927",
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push(new URLSearchParams(String(init.body)));
        if (url === VKID_ENDPOINTS.token) return OK({ access_token: "at", user_id: "77" });
        return OK({ user: { user_id: "77", email: "a@ya.ru" } });
      }) as unknown as typeof fetch,
    });

    await adapter.exchange({
      code: "c-1", codeVerifier: "v".repeat(43), deviceId: "d-1",
      state: "s".repeat(43), redirectUri: "vk53814927://vk.com/blank.html",
    });

    const body = sent[0]!;
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "c-1",
      // Проверочный код — ПРИЛОЖЕНИЯ. Свой мы вывести не можем:
      // авторизацию начинали не мы.
      code_verifier: "v".repeat(43),
      device_id: "d-1",
      state: "s".repeat(43),
      client_id: "53814927",
      redirect_uri: "vk53814927://vk.com/blank.html",
    });
  });

  it("без проверочного кода до VK не идёт вовсе", async () => {
    const adapter = createVkidNativeAdapter({
      clientId: "53814927",
      fetchImpl: (async () => { throw new Error("к VK ходить не должны"); }) as unknown as typeof fetch,
    });
    await expect(adapter.exchange({ code: "c", deviceId: "d", state: "s" }))
      .rejects.toThrow();
  });

  it("без device_id до VK не идёт вовсе", async () => {
    const adapter = createVkidNativeAdapter({
      clientId: "53814927",
      fetchImpl: (async () => { throw new Error("к VK ходить не должны"); }) as unknown as typeof fetch,
    });
    await expect(adapter.exchange({ code: "c", codeVerifier: "v".repeat(43), state: "s" }))
      .rejects.toThrow();
  });

  it("отдаёт только идентификатор и почту", async () => {
    const adapter = createVkidNativeAdapter({
      clientId: "53814927",
      fetchImpl: (async (url: string) =>
        url === VKID_ENDPOINTS.token
          ? OK({ access_token: "at", user_id: "77" })
          : OK({ user: { user_id: "77", email: "a@ya.ru", first_name: "Иван",
                         avatar: "https://…", phone: "+7999" } })
      ) as unknown as typeof fetch,
    });
    const identity = await adapter.exchange({
      code: "c", codeVerifier: "v".repeat(43), deviceId: "d", state: "s",
    });
    expect(identity).toEqual({ subject: "77", email: "a@ya.ru", emailVerified: true });
  });
});

describe("Яндекс: нативный обмен", () => {
  it("секрет приложения уходит с НАШЕГО сервера, а не из приложения", async () => {
    const sent: URLSearchParams[] = [];
    const adapter = createYandexNativeAdapter({
      clientId: "cid", clientSecret: "sec",
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (url === YANDEX_ENDPOINTS.token) {
          sent.push(new URLSearchParams(String(init.body)));
          return OK({ access_token: "at" });
        }
        return OK({ id: "42", default_email: "a@ya.ru" });
      }) as unknown as typeof fetch,
    });

    await adapter.exchange({ code: "c-1", codeVerifier: "v".repeat(43) });

    expect(Object.fromEntries(sent[0]!)).toMatchObject({
      grant_type: "authorization_code",
      code: "c-1",
      client_id: "cid",
      client_secret: "sec",
      code_verifier: "v".repeat(43),
    });
  });

  it("работает и без PKCE: у Яндекса он необязателен", async () => {
    const sent: URLSearchParams[] = [];
    const adapter = createYandexNativeAdapter({
      clientId: "cid", clientSecret: "sec",
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (url === YANDEX_ENDPOINTS.token) {
          sent.push(new URLSearchParams(String(init.body)));
          return OK({ access_token: "at" });
        }
        return OK({ id: "42", default_email: "a@ya.ru" });
      }) as unknown as typeof fetch,
    });
    await adapter.exchange({ code: "c-1" });
    expect(Object.fromEntries(sent[0]!)).not.toHaveProperty("code_verifier");
  });
});

describe("подключение нативных SDK по ключам окружения", () => {
  it("без ключей на мобильном экране провайдеров нет", async () => {
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "");
    await connectNativeProviders();
    expect(await availableProviders("android")).toEqual([]);
  });

  it("с ключами оба провайдера доступны нативному входу", async () => {
    vi.stubEnv("YANDEX_CLIENT_ID", "cid");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "sec");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    await connectNativeProviders();
    expect(await availableProviders("android")).toEqual(["yandex", "vkid"]);
    expect(nativeAdapterFor("yandex")).toBeDefined();
    expect(nativeAdapterFor("vkid")).toBeDefined();
  });

  /**
   * У ВК приложение заводится отдельно под каждую платформу, и
   * 11.09.2026 у мобильного входа появился СВОЙ идентификатор,
   * отличный от веб-приложения. Код, выданный SDK мобильного
   * приложения, ВК обменивает только на его же client_id: подставь
   * веб-идентификатор — и придёт `invalid_client`, а человек увидит
   * «вход не работает» без причины.
   *
   * Поэтому у нативного входа своя переменная. Умолчанием она
   * остаётся прежней: пока приложение у ВК одно на все платформы,
   * задавать вторую переменную незачем.
   */
  it("у мобильного ВК свой идентификатор приложения", async () => {
    const { nativeAppIds } = await import("../src/services/providers/native.js");
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    vi.stubEnv("VKID_NATIVE_CLIENT_ID", "60001111");
    await connectNativeProviders();
    expect(await nativeAppIds()).toEqual({ vkid: "60001111" });
  });

  it("без своей переменной мобильный ВК берёт тот же идентификатор, что веб", async () => {
    const { nativeAppIds } = await import("../src/services/providers/native.js");
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    vi.stubEnv("VKID_NATIVE_CLIENT_ID", "");
    await connectNativeProviders();
    expect(await nativeAppIds()).toEqual({ vkid: "53814927" });
  });

  it("негодный VKID_NATIVE_CLIENT_ID не подключается, а к вебу не откатывается", async () => {
    // Откат на веб-идентификатор при опечатке дал бы кнопку, ведущую в
    // чужую ошибку ВК, — ровно то, против чего заведена проверка вида.
    // Лучше ни одной кнопки, чем кнопка в «Ошибка загрузки».
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    vi.stubEnv("VKID_NATIVE_CLIENT_ID", "Zaschischonnyj-Kljuch");
    await connectNativeProviders();
    expect(await availableProviders("android")).toEqual([]);
  });

  it("свой идентификатор мобильного не подменяет веб-вход", async () => {
    // Два приложения ВК живут рядом и не знают друг о друге: браузер
    // уходит на веб-приложение, обмен кода из мобильного идёт на
    // мобильное. Перепутать их — значит сломать ту половину, которая
    // работала.
    const { vkidFromEnv } = await import("../src/services/providers/vkid.js");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    vi.stubEnv("VKID_NATIVE_CLIENT_ID", "60001111");
    const url = new URL(vkidFromEnv()!.authorizationUrl("проба"));
    expect(url.searchParams.get("client_id")).toBe("53814927");
  });

  it("негодный VKID_CLIENT_ID не подключается и на мобильном", async () => {
    // Та же проверка вида, что и в вебе: «Защищённый ключ» вместо
    // «ID приложения» даёт кнопку, ведущую в чужую ошибку.
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "LrkGuB43OdzCkdL3SYsz");
    await connectNativeProviders();
    expect(await availableProviders("android")).toEqual([]);
  });
});

describe("приложению говорят, каким идентификатором заводить SDK", () => {
  /**
   * Агент ПРАКТИКИ едва не завёл SDK Яндекса на СВОЙ client_id — тот,
   * с которым работает их браузерная кнопка. Код, выданный провайдером,
   * принадлежит запросившему приложению; обменивать мы будем нашим, и
   * провайдер откажет. На экране это выглядит как «вход не работает»
   * без причины.
   *
   * Копия наших идентификаторов в четырёх продуктах разойдётся с
   * оригиналом, и никто не заметит, пока вход не отвалится. Поэтому
   * идентификатор едет оттуда же, откуда состав кнопок.
   */
  it("рядом с провайдером назван идентификатор приложения", async () => {
    const { nativeAppIds } = await import("../src/services/providers/native.js");
    vi.stubEnv("YANDEX_CLIENT_ID", "яндекс-приложение");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "sec");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    await connectNativeProviders();
    expect(await nativeAppIds()).toEqual({
      yandex: "яндекс-приложение",
      vkid: "53814927",
    });
  });

  it("неподключённого провайдера в перечне нет", async () => {
    const { nativeAppIds } = await import("../src/services/providers/native.js");
    vi.stubEnv("YANDEX_CLIENT_ID", "");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "");
    vi.stubEnv("VKID_CLIENT_ID", "53814927");
    await connectNativeProviders();
    expect(await nativeAppIds()).toEqual({ vkid: "53814927" });
  });

  it("секрет приложения сюда не попадает ни при каких условиях", async () => {
    const { nativeAppIds } = await import("../src/services/providers/native.js");
    vi.stubEnv("YANDEX_CLIENT_ID", "cid");
    vi.stubEnv("YANDEX_CLIENT_SECRET", "совершенно-секретно");
    vi.stubEnv("VKID_CLIENT_ID", "");
    await connectNativeProviders();
    expect(JSON.stringify(await nativeAppIds())).not.toContain("совершенно-секретно");
  });
});
