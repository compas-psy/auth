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

export interface NativeAdapter {
  provider: Provider;
  /**
   * Меняет код, полученный приложением от SDK провайдера, на личность.
   * Обмен идёт НА СЕРВЕРЕ провайдера: код не принимается на слово.
   * Токены провайдера после обмена не сохраняются (§2.8 п. 4).
   */
  exchange(code: string): Promise<NativeIdentity>;
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
