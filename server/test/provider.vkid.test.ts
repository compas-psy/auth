import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createVkidAdapter, VKID_ENDPOINTS, vkidFromEnv } from "../src/services/providers/vkid.js";

/**
 * VK ID — не «ещё один Яндекс».
 *
 * Протокол сверен с официальной документацией через context7
 * (id.vk.ru/about/business/go/docs/en/vkid/latest/vk-id/connection/api-description).
 * Три отличия, каждое из которых ломает вход, если его пропустить:
 *
 *   1. PKCE ОБЯЗАТЕЛЕН: в запрос авторизации идёт code_challenge, в
 *      обмен — code_verifier.
 *   2. На возврат приходит device_id, и без него обмен не проходит.
 *   3. В обмене обязателен state — тот же, что уходил в авторизацию.
 *
 * Домен именно id.vk.ru: в документации он такой.
 */

const CONFIG = {
  clientId: "53246810",
  redirectUri: "https://auth.cmpas.ru/callback/vkid",
};

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function formOf(call: unknown[]): URLSearchParams {
  const init = call[1] as { body?: unknown };
  return new URLSearchParams(String(init.body));
}

describe("VK ID: запрос авторизации", () => {
  it("уходит на id.vk.ru с обязательными параметрами", () => {
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: vi.fn() });
    const url = new URL(adapter.authorizationUrl("state-32-символа-и-больше-aaaaaaaa"));

    expect(`${url.origin}${url.pathname}`).toBe(VKID_ENDPOINTS.authorize);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("не просит ни телефона, ни личных данных — только почту", () => {
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: vi.fn() });
    const scope = new URL(adapter.authorizationUrl("s".repeat(40))).searchParams.get("scope");
    expect(scope).toBe("email");
    // Телефон запрещён И-2 в схеме; просить его — собирать впрок то,
    // чего нам и хранить негде.
    expect(scope).not.toContain("phone");
  });

  it("проверочный код выводится из state, а не хранится в базе", () => {
    // Таблица состояний обещает: одноразовых секретов в открытом виде
    // в базе не появляется (0010_provider_states.sql). Проверочный код
    // PKCE обязан быть восстановим на возврате — значит выводим его из
    // state, который и так лежит только хешем.
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: vi.fn() });
    const state = "одинаковый-state-" + "x".repeat(30);
    const a = new URL(adapter.authorizationUrl(state)).searchParams.get("code_challenge");
    const b = new URL(adapter.authorizationUrl(state)).searchParams.get("code_challenge");
    expect(a).toBe(b);

    const other = new URL(adapter.authorizationUrl("другой-" + "y".repeat(40)))
      .searchParams.get("code_challenge");
    expect(other).not.toBe(a);
  });
});

describe("VK ID: обмен кода", () => {
  function fakeVk(user: Record<string, unknown>, userId = "1234567") {
    return vi.fn(async (url: string) => {
      if (url === VKID_ENDPOINTS.token) {
        return new Response(
          JSON.stringify({ access_token: "vk-access", user_id: userId }),
          { status: 200 },
        );
      }
      if (url === VKID_ENDPOINTS.userInfo) {
        return new Response(JSON.stringify({ user }), { status: 200 });
      }
      throw new Error(`неожиданный адрес: ${url}`);
    }) as unknown as typeof fetch;
  }

  const RETURN = { code: "vk-code", state: "s".repeat(40), deviceId: "dev-77" };

  it("шлёт всё, чего требует VK, включая device_id и code_verifier", async () => {
    const impl = fakeVk({ user_id: "1234567", email: "a@vk.test" });
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: impl });
    await adapter.exchange(RETURN);

    const calls = (impl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const token = formOf(calls[0]!);
    expect(token.get("grant_type")).toBe("authorization_code");
    expect(token.get("code")).toBe("vk-code");
    expect(token.get("device_id")).toBe("dev-77");
    expect(token.get("client_id")).toBe(CONFIG.clientId);
    expect(token.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(token.get("state")).toBe(RETURN.state);

    // Проверочный код обязан соответствовать тому, что ушло в
    // авторизацию: иначе VK отвергнет обмен, а мы этого не заметим.
    const challenge = new URL(adapter.authorizationUrl(RETURN.state))
      .searchParams.get("code_challenge");
    expect(challengeOf(token.get("code_verifier")!)).toBe(challenge);
  });

  it("личность — устойчивый идентификатор и почта, больше ничего", async () => {
    const adapter = createVkidAdapter({
      ...CONFIG,
      fetchImpl: fakeVk({
        user_id: "1234567", email: "a@vk.test",
        first_name: "Иван", last_name: "Петров", avatar: "https://vk/pic",
        sex: 2, birthday: "1.1.1990", phone: "79990000000", verified: true,
      }),
    });

    const identity = await adapter.exchange(RETURN);
    expect(identity).toEqual({
      subject: "1234567", email: "a@vk.test", emailVerified: true,
    });
    // Ни ФИО, ни аватара, ни пола, ни дня рождения, ни телефона.
    expect(JSON.stringify(identity)).not.toMatch(/Иван|Петров|pic|79990000000|1990/);
  });

  it("без почты личность приходит без почты, а не с выдуманной", async () => {
    const adapter = createVkidAdapter({
      ...CONFIG, fetchImpl: fakeVk({ user_id: "1234567" }),
    });
    const identity = await adapter.exchange(RETURN);
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it("без идентификатора вход не состоится", async () => {
    const impl = vi.fn(async (url: string) => {
      if (url === VKID_ENDPOINTS.token) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      return new Response(JSON.stringify({ user: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: impl });
    await expect(adapter.exchange(RETURN)).rejects.toThrow();
  });

  it("отказ VK не превращается в молчаливый вход", async () => {
    const impl = vi.fn(async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: impl });
    await expect(adapter.exchange(RETURN)).rejects.toThrow();
  });

  it("возврат без device_id отвергается до обращения к VK", async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const adapter = createVkidAdapter({ ...CONFIG, fetchImpl: impl });
    await expect(adapter.exchange({ ...RETURN, deviceId: undefined })).rejects.toThrow();
    expect((impl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe("VK ID: подключение по ключам из окружения", () => {
  const saved = process.env.VKID_CLIENT_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.VKID_CLIENT_ID;
    else process.env.VKID_CLIENT_ID = saved;
  });

  it("без ключа провайдер не подключается вовсе", () => {
    delete process.env.VKID_CLIENT_ID;
    expect(vkidFromEnv("https://auth.cmpas.ru")).toBeNull();
  });

  it("подключается с идентификатором приложения", () => {
    process.env.VKID_CLIENT_ID = "53814927";
    const adapter = vkidFromEnv("https://auth.cmpas.ru");
    expect(adapter).not.toBeNull();
    expect(new URL(adapter!.authorizationUrl("s".repeat(43))).searchParams.get("client_id"))
      .toBe("53814927");
  });

  /**
   * Учредитель 10.09.2026 положил в VKID_CLIENT_ID «Защищённый ключ»
   * приложения вместо «ID приложения». Кнопка на экране появилась,
   * человек нажал — и увидел от VK «Ошибка загрузки»: приложения с
   * таким client_id у них нет.
   *
   * Отказа при этом не было НИГДЕ: ни в нашем журнале, ни на экране.
   * Догадаться было можно только по виду значения.
   */
  it("защищённый ключ вместо идентификатора приложения не подключается", () => {
    process.env.VKID_CLIENT_ID = "LrkGuB43OdzCkdL3SYsz";
    expect(vkidFromEnv("https://auth.cmpas.ru")).toBeNull();
  });

  it("пробелы по краям не делают ключ негодным", () => {
    process.env.VKID_CLIENT_ID = "  53814927\n";
    expect(vkidFromEnv("https://auth.cmpas.ru")).not.toBeNull();
  });

  it("отказ подключения виден в журнале и не несёт значения ключа", () => {
    process.env.VKID_CLIENT_ID = "LrkGuB43OdzCkdL3SYsz";
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
    try {
      vkidFromEnv("https://auth.cmpas.ru");
    } finally {
      write.mockRestore();
    }
    const printed = lines.join("");
    expect(printed).toContain("provider_not_connected");
    expect(printed).toContain("vkid");
    // Значение — это ключ приложения. В журнале ему не место, даже
    // когда оно положено не в ту переменную.
    expect(printed).not.toContain("LrkGuB43OdzCkdL3SYsz");
  });
});
