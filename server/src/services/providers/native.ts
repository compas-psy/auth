import { PROVIDERS, type Provider } from "../accounts.js";

/**
 * Личность, которую внешний сервис отдал после проверки кода.
 * Ни аватара, ни ФИО здесь нет: мы их не показываем и не храним
 * (02_SIMPASID.md §2.8).
 */
export interface NativeIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Что приложение приносит с собой после входа через SDK провайдера.
 *
 * Не один только код. В БРАУЗЕРНОМ входе авторизацию начинаем мы, и
 * потому знаем и state, и проверочный код PKCE — он выводится из
 * state ключом сервиса. В НАТИВНОМ её начинает приложение: эти
 * значения существуют только у него, и без них обмен у провайдера не
 * пройдёт.
 *
 * Секретом приложения тут ничего не является: `code_verifier` —
 * одноразовая величина одной попытки входа, а не ключ. Ключ
 * приложения на устройстве не появляется ни в каком виде.
 */
export interface NativeExchange {
  code: string;
  /** Проверочный код PKCE, который приложение загадало перед входом. */
  codeVerifier?: string;
  /** Идентификатор устройства от провайдера. Требует VK ID. */
  deviceId?: string;
  /** Та же строка состояния, с которой приложение начинало вход. */
  state?: string;
  /** Адрес возврата, который приложение назвало провайдеру. */
  redirectUri?: string;
}

export interface NativeAdapter {
  provider: Provider;
  /**
   * Идентификатор НАШЕГО приложения у провайдера.
   *
   * Им приложение обязано инициализировать SDK: код, выданный
   * провайдером, принадлежит запросившему приложению, а обмен идёт
   * нашими ключами. Заведи SDK на чужой идентификатор — провайдер
   * откажет, и человек увидит «вход не работает» без причины.
   *
   * Секретом не является: `client_id` едет в строке запроса каждого
   * обращения к провайдеру и виден всякому, кто открыл экран входа.
   */
  appId: string;
  /**
   * Меняет код, полученный приложением от SDK провайдера, на личность.
   * Обмен идёт НА СЕРВЕРЕ провайдера: код не принимается на слово.
   * Токены провайдера после обмена не сохраняются (§2.8 п. 4).
   */
  exchange(params: NativeExchange): Promise<NativeIdentity>;
}

/**
 * Подключённые нативные SDK.
 *
 * ПУСТО, и это не забывчивость и не заглушка.
 *
 * Наличие и условия Android-SDK у Яндекс ID, T-ID, Сбер ID и VK ID —
 * **не проверено**. Это прямо названо действием человека, а не агента
 * (12_NATIVE_AUTH.md §6, design/ЧИТАТЬ_ПЕРВЫМ.md «Не проверено»).
 * До ответа по конкретному провайдеру он:
 *   - не показывается на мобильном экране (§2.2),
 *   - не обслуживается на маршруте обмена.
 * Это следствие требования, а не ошибка.
 *
 * Чтобы подключить провайдера, человек получает документацию SDK, а
 * агент добавляет адаптер через registerNativeAdapter. Механизм готов
 * и закрыт тестами; не хватает ровно внешних сведений.
 *
 * Вход по коду из письма доступен всегда — этого требует И-5.
 */
const adapters = new Map<Provider, NativeAdapter>();

export function registerNativeAdapter(adapter: NativeAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function clearNativeAdapters(): void {
  adapters.clear();
}

export function nativeAdapterFor(provider: string): NativeAdapter | undefined {
  return adapters.get(provider as Provider);
}

export function hasNativeSdk(provider: string): boolean {
  return adapters.has(provider as Provider);
}

/**
 * Идентификаторы приложений для подключённых нативных SDK.
 *
 * Отдаются приложению рядом с составом кнопок — оттуда же, откуда оно
 * берёт перечень провайдеров. Копия этих значений, вписанная в четыре
 * продукта руками, через полгода разойдётся с оригиналом, и никто не
 * заметит, пока вход не отвалится.
 */
export async function nativeAppIds(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [provider, adapter] of adapters) out[provider] = adapter.appId;
  return out;
}

export function isMobilePlatform(platform: string): boolean {
  return platform === "android" || platform === "ios";
}

/**
 * Состав способов входа для платформы.
 *
 * Веб и мобильный контур подключаются РАЗНЫМИ вещами и потому считаются
 * раздельно: в вебе провайдер работает редиректом и ему нужны ключи
 * приложения, на мобильном — нативным SDK, которого может не быть даже
 * там, где ключи есть. Провайдер с ключами, но без SDK, на мобильном
 * экране не показывается — так требует 12_NATIVE_AUTH.md §2.2.
 */
/**
 * Способы входа НА ЭКРАНЕ В БРАУЗЕРЕ — независимо от того, с телефона
 * человек пришёл или из-за стола.
 *
 * Отдельная функция, а не availableProviders("web") по месту: разница
 * между «платформой устройства» и «видом экрана» уже стоила человеку
 * работающего способа войти. Экран входа считал состав по User-Agent,
 * телефонный браузер попадал в мобильную ветку — и знак Яндекса
 * пропадал, оставив на экране объяснение про внешний сервис над пустым
 * местом.
 *
 * Правило «провайдер без нативного SDK не показывается» (12_NATIVE_AUTH.md
 * §2.2) — про НАШЕ ПРИЛОЖЕНИЕ, где вход идёт через SDK провайдера.
 * В браузере вход идёт редиректом, и редирект на телефоне работает так
 * же, как на столе.
 */
export function browserProviders(): Promise<Provider[]> {
  return availableProviders("web");
}

export async function availableProviders(platform: string): Promise<Provider[]> {
  if (isMobilePlatform(platform)) {
    return PROVIDERS.filter((p) => adapters.has(p));
  }
  const { connectedWebProviders } = await import("./registry.js");
  const connected = new Set(connectedWebProviders());
  // Порядок задаётся перечнем PROVIDERS, а не порядком подключения:
  // кнопки не должны переставляться сами по себе.
  return PROVIDERS.filter((p) => connected.has(p));
}

/**
 * Подключает нативные SDK по ключам окружения.
 *
 * Ключи те же, что и у браузерного входа: приложение у провайдера
 * одно, различается только способ, которым человек до него доходит.
 * Отдельного «мобильного» приложения у провайдера заводить не нужно —
 * и заводить не стоит: две регистрации означают две пары ключей и два
 * места, где что-то протухнет.
 *
 * Провайдер без ключей на мобильном экране не показывается и на
 * маршруте обмена не обслуживается — кнопка, ведущая в чужую ошибку,
 * хуже отсутствующей кнопки.
 */
export async function connectNativeProviders(): Promise<void> {
  clearNativeAdapters();

  const { yandexNativeFromEnv } = await import("./yandex.js");
  const yandex = yandexNativeFromEnv();
  if (yandex) registerNativeAdapter(yandex);

  const { vkidNativeFromEnv } = await import("./vkid.js");
  const vkid = vkidNativeFromEnv();
  if (vkid) registerNativeAdapter(vkid);

  const { logger } = await import("../../lib/logging.js");
  logger.info({ event: "native_sdk_connected", providers: [...adapters.keys()] });
}
