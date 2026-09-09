import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  beginAuthorization, completeCallback, PORTAL_CLIENT_ID, __resetTokenForTests,
  currentToken,
} from "../src/auth/oidc";

/**
 * Портал предъявляет себя API так же, как это делает любой продукт, —
 * ключом доступа по OIDC. Отдельного внутреннего пути для наших
 * собственных интерфейсов не существует (CLAUDE.md, «Правило,
 * снимающее самодеятельность»).
 *
 * До этой правки портал ходил в /v1 ТОЛЬКО с cookie, а API принимает
 * ТОЛЬКО Bearer. Значит портал не открывался ни разу и ни у кого:
 * getAccount() падал с 401, обещание никто не ловил, и на экране
 * оставался пустой div. Проверено запросом к собранному серверу:
 * «/v1/account с одной cookie → 401».
 */

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  __resetTokenForTests();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("localStorage", {
    setItem: () => { throw new Error("портал не имеет права писать в localStorage"); },
    getItem: () => null,
    removeItem: () => undefined,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("портал начинает вход", () => {
  it("уводит на наш же экран входа с кодом и PKCE", async () => {
    // Адрес относительный намеренно: перенаправление внутри своего домена.
    const url = new URL(await beginAuthorization("/account/security"), "https://auth.cmpas.ru");
    expect(url.pathname).toBe("/oidc/auth");
    expect(url.searchParams.get("client_id")).toBe(PORTAL_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    // S256 и только он: plain сводит PKCE к украшению.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("проверяющее значение и state остаются в этой вкладке, а не в localStorage", async () => {
    // sessionStorage живёт до закрытия вкладки; localStorage переживает
    // её и делится между вкладками — для проверяющего значения PKCE это
    // лишний срок жизни.
    await beginAuthorization("/account");
    expect(store.size).toBeGreaterThan(0);
    expect(() => localStorage.setItem("x", "y")).toThrow();
  });

  it("запоминает, куда человек шёл", async () => {
    await beginAuthorization("/account/devices");
    expect([...store.values()].join(" ")).toContain("/account/devices");
  });
});

describe("портал возвращается с кодом", () => {
  it("чужой state не принимается", async () => {
    // Вернувшийся код с подделанным state — это попытка подсунуть
    // порталу чужой вход. Молча принять его нельзя.
    await beginAuthorization("/account");
    await expect(completeCallback(new URLSearchParams({ code: "c", state: "чужой" })))
      .rejects.toThrow(/state/i);
  });

  it("меняет код на ключ доступа и не сохраняет его в хранилище", async () => {
    const url = new URL(await beginAuthorization("/account"), "https://auth.cmpas.ru");
    const state = url.searchParams.get("state")!;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      JSON.stringify({ access_token: "at-1", token_type: "Bearer", expires_in: 900 }),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const to = await completeCallback(new URLSearchParams({ code: "c-1", state }));
    expect(to).toBe("/account");
    expect(currentToken()).toBe("at-1");

    // Ключ доступа живёт в памяти вкладки. В хранилище его нет: строка
    // хранилища с ключом входа переживает вкладку и достаётся любому
    // скрипту на этом домене.
    expect([...store.values()].join(" ")).not.toContain("at-1");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_secret"), "у публичного клиента секрета нет").toBeNull();
  });

  it("отказ провайдера не выдаётся за вход", async () => {
    await beginAuthorization("/account");
    await expect(completeCallback(new URLSearchParams({ error: "access_denied" })))
      .rejects.toThrow();
  });
});
