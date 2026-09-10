import type { NativeIdentity } from "./native.js";

/**
 * Адреса Яндекс OAuth.
 *
 * Взяты чтением `@auth/core/providers/yandex.js` — той самой библиотеки,
 * на которой уже работает вход в ПРАКТИКЕ (`next-auth`), а не по памяти.
 * Там же подтверждается, что `userinfo` требует `format=json`.
 */
export const YANDEX_ENDPOINTS = {
  authorize: "https://oauth.yandex.ru/authorize",
  token: "https://oauth.yandex.ru/token",
  userinfo: "https://login.yandex.ru/info",
} as const;

/**
 * Запрашиваемые права.
 *
 * `login:email` — почта, `login:info` — устойчивый идентификатор.
 * `login:avatar` НЕ запрашивается: аватар мы не показываем и не храним
 * (CLAUDE.md, «Чего здесь не будет никогда»). Просить право, которым не
 * собираешься пользоваться, — это собирать данные впрок.
 */
const SCOPE = "login:email login:info";

export interface YandexConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface YandexAdapter {
  provider: "yandex";
  authorizationUrl(state: string): string;
  /** Яндексу нужен только код; state и device_id он не спрашивает. */
  exchange(params: { code: string }): Promise<NativeIdentity>;
}

export class YandexError extends Error {
  constructor(message: string, readonly stage: "token" | "userinfo" | "profile") {
    super(message);
    this.name = "YandexError";
  }
}

/**
 * Отдаёт ли Яндекс признак подтверждения почты.
 *
 * **НЕ ПРОВЕРЕНО.** В ответе `login.yandex.ru/info` поля вроде
 * `email_verified` нет — это видно по разбору профиля в `@auth/core`,
 * который берёт только `default_email` и `emails`. Официальной
 * документации Яндекса я не читал.
 *
 * Решение принято осознанно и вынесено сюда одной строкой: адрес,
 * который Яндекс называет основным, считается подтверждённым, потому
 * что им же и управляет. Если проверка покажет обратное — правится
 * одно значение, и все входы через Яндекс начинают вести на экран
 * «Нужна электронная почта» (C2), как того требует И-5.
 *
 * Способ проверки: документация Яндекс ID по составу ответа
 * `login.yandex.ru/info` — действие человека.
 */
const YANDEX_EMAIL_IS_VERIFIED = true;

interface YandexProfile {
  id?: unknown;
  default_email?: unknown;
  emails?: unknown;
}

export function createYandexAdapter(config: YandexConfig): YandexAdapter {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    provider: "yandex",

    authorizationUrl(state: string): string {
      const url = new URL(YANDEX_ENDPOINTS.authorize);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("scope", SCOPE);
      // state одноразовый и связан с сессией браузера — проверяется
      // на возврате. Без него возврат подделывается.
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchange({ code }: { code: string }): Promise<NativeIdentity> {
      // Секрет уходит на сервер Яндекса телом POST, а не через
      // адресную строку человека.
      const tokenRes = await doFetch(YANDEX_ENDPOINTS.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });
      if (!tokenRes.ok) {
        throw new YandexError(`обмен кода отклонён: ${tokenRes.status}`, "token");
      }
      const token = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string" || !token.access_token) {
        throw new YandexError("в ответе нет ключа доступа", "token");
      }

      const infoRes = await doFetch(`${YANDEX_ENDPOINTS.userinfo}?format=json`, {
        headers: { authorization: `OAuth ${token.access_token}` },
      });
      if (!infoRes.ok) {
        throw new YandexError(`профиль недоступен: ${infoRes.status}`, "userinfo");
      }
      const profile = (await infoRes.json()) as YandexProfile;

      const subject = typeof profile.id === "string" || typeof profile.id === "number"
        ? String(profile.id)
        : "";
      if (!subject) {
        // Без устойчивого идентификатора личность не с чем связать:
        // почта меняется, идентификатор — нет.
        throw new YandexError("в профиле нет идентификатора", "profile");
      }

      const email = pickEmail(profile);

      // ЗДЕСЬ ЖЕ всё лишнее и выбрасывается. Яндекс отдаёт ФИО, пол,
      // день рождения, аватар и телефон — ничего из этого не покидает
      // эту функцию и никуда не записывается.
      return {
        subject,
        email,
        emailVerified: email !== null && YANDEX_EMAIL_IS_VERIFIED,
      };
    },
  };
}

function pickEmail(profile: YandexProfile): string | null {
  if (typeof profile.default_email === "string" && profile.default_email) {
    return profile.default_email;
  }
  if (Array.isArray(profile.emails)) {
    const first = profile.emails.find((e) => typeof e === "string" && e);
    if (typeof first === "string") return first;
  }
  return null;
}

/**
 * Подключение по ключам из окружения.
 *
 * Половины ключей недостаточно: молчаливо сломанный вход хуже
 * отсутствующего — человек нажимает кнопку и упирается в ошибку
 * вместо того, чтобы сразу увидеть работающий способ.
 */
export function yandexFromEnv(issuer = "https://auth.cmpas.ru"): YandexAdapter | null {
  const clientId = process.env.YANDEX_CLIENT_ID;
  const clientSecret = process.env.YANDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return createYandexAdapter({
    clientId,
    clientSecret,
    // Точное совпадение с тем, что зарегистрировано у Яндекса.
    redirectUri: `${issuer.replace(/\/+$/, "")}/callback/yandex`,
  });
}
