/**
 * Вход портала аккаунта.
 *
 * Портал предъявляет себя публичному API так же, как это делает любой
 * продукт, — ключом доступа по OIDC. Отдельного внутреннего пути для
 * наших собственных интерфейсов не существует (CLAUDE.md, «Правило,
 * снимающее самодеятельность»), и cookie сессии SSO таким путём была бы:
 * её принимал бы только наш портал.
 *
 * ЧТО БЫЛО ДО ЭТОГО. Портал ходил в /v1 только с cookie, а API
 * принимает только Bearer. Значит портал не открывался НИ РАЗУ И НИ У
 * КОГО: getAccount() падал с 401, обещание никто не ловил, и на экране
 * оставался пустой div с aria-busy. Ни ошибки, ни объяснения.
 *
 * Ключ доступа живёт В ПАМЯТИ ВКЛАДКИ и никуда не сохраняется. Строка
 * хранилища с ключом входа переживает вкладку и достаётся любому
 * скрипту на этом домене; перезагрузка страницы дешевле — при живой
 * сессии SSO вход проходит без единого экрана.
 */

export const PORTAL_CLIENT_ID = "account-portal";
export const PORTAL_REDIRECT_PATH = "/account/callback";

const VERIFIER_KEY = "simpas_portal_verifier";
const STATE_KEY = "simpas_portal_state";
const RETURN_KEY = "simpas_portal_return";

let token: string | null = null;

export function currentToken(): string | null {
  return token;
}

/** Только для проверок. */
export function __resetTokenForTests(): void {
  token = null;
}

export function forgetToken(): void {
  token = null;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Готовит запрос авторизации и возвращает адрес, куда уводить человека.
 *
 * prompt=none не запрашивается намеренно: при живой сессии SSO провайдер
 * и так вернёт код молча, а при отсутствии — покажет обычный экран
 * входа. Два запроса вместо одного дали бы то же самое.
 */
export async function beginAuthorization(returnTo: string): Promise<string> {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(RETURN_KEY, returnTo);

  const q = new URLSearchParams({
    client_id: PORTAL_CLIENT_ID,
    response_type: "code",
    redirect_uri: new URL(PORTAL_REDIRECT_PATH, location.origin).toString(),
    scope: "openid email",
    state,
    nonce: randomString(16),
    code_challenge: await challengeFor(verifier),
    // S256 и только он: plain сводит PKCE к украшению.
    code_challenge_method: "S256",
  });
  return `/oidc/auth?${q}`;
}

/**
 * Разбирает возврат и меняет код на ключ доступа.
 * Возвращает адрес, куда человек шёл до входа.
 */
export async function completeCallback(params: URLSearchParams): Promise<string> {
  const error = params.get("error");
  if (error) {
    // Отказ провайдера — это отказ, а не вход. Молча продолжить нельзя.
    clearFlow();
    throw new Error(`вход не выполнен: ${error}`);
  }

  const code = params.get("code");
  const state = params.get("state");
  const expected = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!code || !state || !expected || state !== expected || !verifier) {
    // Вернувшийся код с чужим state — попытка подсунуть порталу чужой
    // вход. Принять его молча значило бы пустить не того человека.
    clearFlow();
    throw new Error("не совпал state: возврат не наш");
  }

  const res = await fetch("/oidc/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL(PORTAL_REDIRECT_PATH, location.origin).toString(),
      client_id: PORTAL_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    clearFlow();
    throw new Error("обмен кода не прошёл");
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    clearFlow();
    throw new Error("ключ доступа не выдан");
  }

  token = body.access_token;
  const returnTo = sessionStorage.getItem(RETURN_KEY) ?? "/account";
  clearFlow();
  return returnTo;
}

function clearFlow(): void {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(RETURN_KEY);
}
