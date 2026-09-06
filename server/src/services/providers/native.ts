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

/**
 * Провайдеры, подключённые для веба (OIDC с редиректом).
 *
 * Тоже пусто на Э2: договоры и регистрация приложений — действие
 * человека, а подключение внешних провайдеров вынесено в Э5
 * (docs/plan/E2.md, «Границы этого плана»). Экран входа обязан не
 * разваливаться при любом их числе, включая ноль, и это закрыто тестом.
 */
const WEB_PROVIDERS_READY: ReadonlySet<Provider> = new Set<Provider>();

export function isMobilePlatform(platform: string): boolean {
  return platform === "android" || platform === "ios";
}

export async function availableProviders(platform: string): Promise<Provider[]> {
  return isMobilePlatform(platform)
    ? PROVIDERS.filter((p) => adapters.has(p))
    : PROVIDERS.filter((p) => WEB_PROVIDERS_READY.has(p));
}
