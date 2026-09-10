import { createHash, createHmac } from "node:crypto";
import { loadOrCreateKeys } from "../../lib/keys.js";
import { logger } from "../../lib/logging.js";
import type { NativeIdentity } from "./native.js";

/**
 * Адреса VK ID.
 *
 * Сверено с официальной документацией через context7
 * (id.vk.ru/about/business/go/docs/en/vkid/latest/vk-id/connection/api-description),
 * а не по памяти. Домен — id.vk.ru.
 */
export const VKID_ENDPOINTS = {
  authorize: "https://id.vk.ru/authorize",
  token: "https://id.vk.ru/oauth2/auth",
  userInfo: "https://id.vk.ru/oauth2/user_info",
} as const;

/**
 * Запрашиваемое право — только почта.
 *
 * `vkid.personal_info` (умолчание VK) дало бы ФИО, аватар, пол и день
 * рождения: ничего из этого мы не показываем и не храним (CLAUDE.md,
 * «Чего здесь не будет никогда»). Телефон не просим тем более — колонок
 * под него нет и быть не может (И-2).
 *
 * Устойчивый идентификатор берётся не отсюда: VK отдаёт `user_id` прямо
 * в ответе на обмен кода.
 */
const SCOPE = "email";

/**
 * Отдаёт ли VK подтверждённую почту.
 *
 * **НЕ ПРОВЕРЕНО.** В ответе `oauth2/user_info` признака подтверждения
 * почты нет — есть поле `verified`, но оно про верификацию ПРОФИЛЯ
 * (галочку), а не про почту. Официальная документация о подтверждении
 * адреса не говорит.
 *
 * Решение учредителя 10.09.2026 на прямой вопрос: считать подтверждённой,
 * как у Яндекса. Вынесено одной строкой намеренно: выяснится обратное —
 * правится одно значение, и все входы через VK начинают вести на экран
 * «Нужна электронная почта» (C2), как того требует И-5.
 *
 * Цена ошибки названа вслух: у ПРАКТИКИ включён
 * allowDangerousEmailAccountLinking, и неподтверждённый адрес там
 * связывается с существующей учётной записью по почте.
 *
 * Способ проверки: документация VK ID или ответ их поддержки о том,
 * подтверждается ли адрес перед выдачей в scope `email`, — действие
 * человека.
 */
const VKID_EMAIL_IS_VERIFIED = true;

export interface VkidConfig {
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

/** Что приходит на адрес возврата: код, state и идентификатор устройства. */
export interface VkidReturn {
  code: string;
  state: string;
  deviceId?: string;
}

export interface VkidAdapter {
  provider: "vkid";
  authorizationUrl(state: string): string;
  exchange(params: VkidReturn): Promise<NativeIdentity>;
}

export class VkidError extends Error {
  constructor(message: string, readonly stage: "return" | "token" | "userinfo" | "profile") {
    super(message);
    this.name = "VkidError";
  }
}

/**
 * Проверочный код PKCE ВЫВОДИТСЯ из state, а не хранится.
 *
 * VK требует прислать `code_verifier` в обмене — значит его надо чем-то
 * помнить между уходом и возвратом. Положить его в таблицу состояний
 * значило бы нарушить её же обещание: «одноразовых секретов в открытом
 * виде в базе не появляется» (0010_provider_states.sql).
 *
 * Поэтому код выводится из state ключом сервиса. State и так одноразовый,
 * живёт пятнадцать минут, хранится только хешем и гасится при первом
 * предъявлении — все его свойства достаются выведенному коду даром, а в
 * базе не появляется ни одного нового секрета.
 *
 * base64url от 32 байт — 43 знака из [A-Za-z0-9_-]: ровно нижняя
 * граница длины, которую требует VK (43…128).
 */
export function codeVerifierFor(state: string): string {
  return createHmac("sha256", serviceKey()).update(state).digest("base64url");
}

function serviceKey(): string {
  const keys = loadOrCreateKeys();
  const first = keys.keys[0];
  // То же значение, что подписывает cookie: уже секретно, лежит в томе
  // с режимом 600 и переживает перезапуск — иначе возврат от VK
  // переставал бы сходиться после каждой выкладки.
  return String(first?.d ?? first?.kid ?? "simpasid");
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface VkUser {
  user_id?: unknown;
  email?: unknown;
}

export function createVkidAdapter(config: VkidConfig): VkidAdapter {
  const doFetch = config.fetchImpl ?? fetch;

  async function form(url: string, body: URLSearchParams, stage: "token" | "userinfo") {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new VkidError(`VK ответил ${res.status}`, stage);
    return res.json() as Promise<Record<string, unknown>>;
  }

  return {
    provider: "vkid",

    authorizationUrl(state: string): string {
      const url = new URL(VKID_ENDPOINTS.authorize);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challengeFor(codeVerifierFor(state)));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("scope", SCOPE);
      return url.toString();
    },

    async exchange({ code, state, deviceId }: VkidReturn): Promise<NativeIdentity> {
      // device_id приходит на возврат вместе с кодом и обязателен в
      // обмене. Нет его — до VK не идём: без него обмен всё равно не
      // пройдёт, а лишний запрос с чужим кодом делать незачем.
      if (!deviceId) throw new VkidError("возврат без device_id", "return");

      const token = await form(VKID_ENDPOINTS.token, new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifierFor(state),
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        device_id: deviceId,
        // state обязателен и в обмене — так требует документация VK.
        state,
      }), "token");

      const accessToken = token.access_token;
      if (typeof accessToken !== "string" || !accessToken) {
        throw new VkidError("в ответе нет ключа доступа", "token");
      }

      const info = await form(VKID_ENDPOINTS.userInfo, new URLSearchParams({
        client_id: config.clientId,
        access_token: accessToken,
      }), "userinfo");
      const user = (info.user ?? {}) as VkUser;

      // Идентификатор берётся из ответа на обмен: он документирован как
      // обязательное поле. Профиль — запасной источник.
      const subject = str(token.user_id) || str(user.user_id);
      if (!subject) {
        // Почта меняется, идентификатор — нет. Без него связывать нечего.
        throw new VkidError("VK не назвал идентификатор человека", "profile");
      }

      const email = typeof user.email === "string" && user.email ? user.email : null;

      // ЗДЕСЬ ЖЕ выбрасывается всё лишнее. VK отдаёт ФИО, аватар, пол,
      // день рождения и телефон — ничего из этого не покидает функцию
      // и никуда не записывается.
      return { subject, email, emailVerified: email !== null && VKID_EMAIL_IS_VERIFIED };
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * Как выглядит «ID приложения» VK.
 *
 * В настройках приложения VK рядом лежат два значения, и перепутать их
 * легко: «ID приложения» — число, «Защищённый ключ» — двадцать знаков
 * вперемешку буквами и цифрами. Нужен первый.
 *
 * **Числовой вид не проверен по документации:** описание метода
 * называет client_id просто «идентификатором приложения» и о составе
 * знаков не говорит. Проверка держится на наблюдении: у всех известных
 * приложений VK идентификатор числовой, а перепутанное значение VK
 * отвергает как `invalid_client`.
 *
 * Способ проверки, если VK когда-нибудь выдаст нечисловой
 * идентификатор: вход через VK перестанет предлагаться, в журнале
 * появится `provider_not_connected`, и правится это выражение —
 * одно место.
 */
const VK_APP_ID = /^[0-9]+$/;

/**
 * Подключение по ключам из окружения.
 *
 * Секрет приложения здесь НЕ нужен: в обмене кода VK его не требует —
 * защита держится на PKCE и зарегистрированном адресе возврата
 * (подтверждено документацией). Просить в окружении то, чем не
 * пользуешься, значит держать лишний секрет на сервере.
 *
 * ── Почему негодное значение обрывает подключение ──────────────────
 *
 * 10.09.2026 в VKID_CLIENT_ID лёг «Защищённый ключ». Кнопка «VK ID» на
 * экране появилась — ключ ведь задан, — человек нажал и увидел от VK
 * «Ошибка загрузки». Ни на экране, ни в нашем журнале не было НИ ОДНОГО
 * следа: мы честно отправили то, что нам дали.
 *
 * Кнопка, ведущая в чужую ошибку, хуже отсутствующей кнопки — то же
 * правило, по которому провайдер без ключей не показывается вовсе.
 * Поэтому негодное значение подключением не считается, а отказ пишется
 * в журнал: иначе пропажа кнопки была бы такой же немой, как ошибка.
 */
export function vkidFromEnv(issuer = "https://auth.cmpas.ru"): VkidAdapter | null {
  // Обрезка краёв: значение приезжает из .env, где перевод строки в
  // конце — обычное дело, а VK такой client_id уже не узнает.
  const clientId = process.env.VKID_CLIENT_ID?.trim();
  if (!clientId) return null;

  if (!VK_APP_ID.test(clientId)) {
    // Значение НЕ печатается: положенный не в ту переменную ключ
    // остаётся ключом. Названы вид ожидаемого и длина — этого хватает,
    // чтобы узнать своё значение, и не хватает, чтобы им
    // воспользоваться.
    logger.warn({
      event: "provider_not_connected",
      provider: "vkid",
      reason: "client_id_not_app_id",
      length: clientId.length,
    });
    return null;
  }

  return createVkidAdapter({
    clientId,
    // Точное совпадение с доверенным адресом в настройках приложения VK.
    redirectUri: `${issuer.replace(/\/+$/, "")}/callback/vkid`,
  });
}
