import { jwtVerify } from "jose";
import type { NativeIdentity, NativeAdapter, NativeExchange } from "./native.js";

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
  constructor(message: string, readonly stage: "return" | "token" | "userinfo" | "profile") {
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

      return profileToIdentity(await fetchProfile(doFetch, token.access_token));
    },
  };
}

/** Профиль Яндекса по ключу доступа. Один на браузерный и нативный вход. */
async function fetchProfile(doFetch: typeof fetch, accessToken: string): Promise<YandexProfile> {
  const infoRes = await doFetch(`${YANDEX_ENDPOINTS.userinfo}?format=json`, {
    headers: { authorization: `OAuth ${accessToken}` },
  });
  if (!infoRes.ok) {
    throw new YandexError(`профиль недоступен: ${infoRes.status}`, "userinfo");
  }
  return (await infoRes.json()) as YandexProfile;
}

/**
 * Личность из профиля — и ЗДЕСЬ ЖЕ всё лишнее выбрасывается.
 *
 * Яндекс отдаёт ФИО, пол, день рождения, аватар и телефон. Ничего из
 * этого не покидает эту функцию и никуда не записывается: у нас нет
 * ни экранов, ни колонок под них, и заводить их нельзя.
 */
function profileToIdentity(profile: YandexProfile): NativeIdentity {
  const subject = typeof profile.id === "string" || typeof profile.id === "number"
    ? String(profile.id)
    : "";
  if (!subject) {
    // Без устойчивого идентификатора личность не с чем связать:
    // почта меняется, идентификатор — нет.
    throw new YandexError("в профиле нет идентификатора", "profile");
  }
  const email = pickEmail(profile);
  return { subject, email, emailVerified: email !== null && YANDEX_EMAIL_IS_VERIFIED };
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

export interface YandexNativeConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Нативный вход через Яндекс ID.
 *
 * Приложение получает код от SDK Яндекса и отдаёт его нам; обмен идёт
 * отсюда. Так секрет приложения остаётся на сервере: положить его в
 * мобильное приложение значит раздать его всем, у кого есть apk.
 *
 * PKCE у Яндекса необязателен (сверено с документацией через
 * `context7`: `POST /token` принимает `code_verifier` как
 * необязательный параметр). Если приложение его использовало —
 * передаём; не использовало — обмен проходит на секрете.
 *
 * ── Android отдаёт не код, а токен ─────────────────────────────────
 *
 * 11.09.2026 агент ПРАКТИКИ прочитал публичный API артефакта
 * `com.yandex.android:authsdk:3.2.1`: результат входа —
 * `YandexAuthResult.Success(YandexAuthToken)`, типа результата с кодом
 * авторизации в SDK нет вовсе. Прежняя оговорка «не проверено» этим
 * закрыта, и закрыта не в нашу пользу: путь через код на Android не
 * существует.
 *
 * Поэтому адаптер принимает ДВА вида предъявления: код (как прежде —
 * веб и всё, что умеет код) и подписанный Яндексом JWT
 * (`YandexAuthSdk.getJwt`).
 *
 * ── Почему JWT, а не сам токен ──────────────────────────────────────
 *
 * Принять голый `access_token` значит принять чужой: токен, выданный
 * ДРУГОМУ приложению Яндекса, подходит к `login.yandex.ru/info` так
 * же, как наш — у ответа нет поля «кому выдан». Злоумышленник,
 * заманивший человека в своё приложение, предъявил бы нам его токен и
 * вошёл бы ЕГО учётной записью. Это подмена токена, ровно то, ради
 * чего в OIDC появился `id_token`.
 *
 * JWT закрывает это подписью: Яндекс подписывает его секретным ключом
 * ПРИЛОЖЕНИЯ (HS256), а секрет нашего приложения лежит только у нас.
 * JWT чужого приложения подписан чужим секретом и проверку не проходит.
 *
 * **НЕ ПРОВЕРЕНО:** что `getJwt` отдаёт JWT, подписанный именно
 * секретом нашего приложения, и что состав полей совпадает с ответом
 * `login.yandex.ru/info`. Документация Яндекса
 * (`yandex.ru/dev/id/doc/ru/tokens/jwt`) описывает подпись HS256
 * секретным ключом приложения для `format=jwt`; про SDK там прямо не
 * сказано, а сам адрес из среды разработки недоступен. Способ
 * проверки — первый живой вход. Несовпадение даёт ОТКАЗ, а не тихий
 * вход: отката на непроверенный токен здесь нет и быть не должно.
 */
export function createYandexNativeAdapter(config: YandexNativeConfig): NativeAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  // Обмен и разбор профиля общие с браузерным входом: адрес возврата
  // Яндексу в обмене не нужен, а всё остальное совпадает буквально.
  return {
    provider: "yandex",
    appId: config.clientId,
    async exchange({ code, jwt, codeVerifier }: NativeExchange): Promise<NativeIdentity> {
      if (jwt) return verifyYandexJwt(jwt, config.clientSecret);
      if (!code) throw new YandexError("предъявлены ни код, ни JWT", "return");
      const tokenRes = await doFetch(YANDEX_ENDPOINTS.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
      });
      if (!tokenRes.ok) {
        throw new YandexError(`обмен кода отклонён: ${tokenRes.status}`, "token");
      }
      const token = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string" || !token.access_token) {
        throw new YandexError("в ответе нет ключа доступа", "token");
      }
      return profileToIdentity(await fetchProfile(doFetch, token.access_token));
    },
  };
}

export function yandexNativeFromEnv(): NativeAdapter | null {
  const clientId = process.env.YANDEX_CLIENT_ID?.trim();
  const clientSecret = process.env.YANDEX_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return createYandexNativeAdapter({ clientId, clientSecret });
}

/**
 * Проверка JWT Яндекса секретом нашего приложения.
 *
 * Алгоритм задан списком, а не взят из заголовка: доверие заголовку —
 * классическая дыра проверяющих JWT, `alg: none` проходит её насквозь.
 * `jose` без явного `algorithms` тоже отвергает `none`, но полагаться
 * на умолчание библиотеки в проверке личности не стоит.
 *
 * Своей криптографии здесь нет: подпись считает библиотека (CLAUDE.md,
 * «чего здесь не будет никогда»).
 */
export async function verifyYandexJwt(
  jwt: string, clientSecret: string,
): Promise<NativeIdentity> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(jwt, new TextEncoder().encode(clientSecret), {
      algorithms: ["HS256"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    // Отказ проверки — отказ. Ошибка ПРОГРАММЫ — поломка, и глотать её
    // нельзя: первая редакция этой функции забыла импорт `jwtVerify`, и
    // сплошной `catch` выдал `ReferenceError` за «подпись не сошлась».
    // Час на поиск причины стоил ровно этих двух строк.
    const code = String((err as { code?: unknown }).code ?? "");
    if (!/^ERR_(JW|JOSE)/.test(code)) throw err;
    // Причина не пересказывается: «подпись не сошлась» и «срок вышел»
    // снаружи должны выглядеть одинаково, иначе отказ становится
    // подсказкой подбирающему.
    throw new YandexError("JWT не прошёл проверку", "return");
  }
  try {
    return profileToIdentity(jwtToProfile(payload));
  } catch (err) {
    /*
     * Подпись сошлась, а личности в нагрузке нет.
     *
     * Значит JWT настоящий, от Яндекса, но называет поля не так, как мы
     * ждём (`id`, `default_email`). Имена полей — не персональные
     * данные: это ключи, а не значения, и приехали они из проверенного
     * подписью документа, а не от того, кто постучался.
     *
     * Без этого разбор стоил бы круга переписки: «пришлите разобранный
     * payload» — «вот ключи» — «а, у вас sub». Ровно этот случай
     * подозревал агент ПРАКТИКИ в issue #27.
     *
     * ЗНАЧЕНИЯ не попадают сюда ни при каких условиях.
     */
    const claims = Object.keys(payload).filter((k) => /^[a-z0-9_]{1,40}$/i.test(k))
      .sort().slice(0, 20).join(",");
    // Отдельным свойством, а не текстом ошибки: в журнал уходит только
    // то, что названо по имени, и текст туда не попадает вовсе.
    throw Object.assign(new YandexError("в JWT нет ожидаемых полей", "profile"), { claims });
  }
}

/**
 * Нагрузка JWT — в тот же вид, что ответ справочника профиля.
 *
 * Настоящий JWT Яндекса называет поля иначе: состав, предъявленный
 * боевым сервером 11.09.2026 (issue #27), — `display_name, email, exp,
 * gender, iat, iss, jti, login, name, phone, psuid, uid`. Подпись при
 * этом сошлась: `getJwt` подписывает секретом нашего приложения.
 *
 * ── Почему `uid`, а не `psuid` ──────────────────────────────────────
 *
 * `psuid` — псевдоним, СВОЙ для каждого приложения. Взять его значит
 * выдать одному человеку разные личности в браузере и в приложении:
 * браузерный вход берёт `id` из `login.yandex.ru/info`, а это тот же
 * `uid`. Человек получил бы две учётные записи и не понял бы, куда
 * делись его записи.
 *
 * Приватность псевдонима здесь проигрывает связности: один человек —
 * одна учётная запись, это обещание сервиса, а не удобство.
 *
 * Прежние имена принимаются тоже: тем же разбором пользуется
 * браузерный путь, и ломать его ради мобильного нельзя.
 *
 * Остальное — `display_name`, `name`, `gender`, `phone` — не переносится
 * никуда. Телефона у нас не может быть ни в одной колонке (И-2), и
 * лучшее место остановить его — здесь, до личности.
 */
function jwtToProfile(payload: Record<string, unknown>): YandexProfile {
  return {
    id: (payload.uid ?? payload.id) as YandexProfile["id"],
    default_email: (payload.email ?? payload.default_email) as string | undefined,
    emails: payload.emails as string[] | undefined,
  };
}
