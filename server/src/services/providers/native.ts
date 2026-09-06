import { PROVIDERS, type Provider } from "../accounts.js";

/**
 * Провайдеры, у которых подключён и ПРОВЕРЕН нативный SDK.
 *
 * Пусто, и это не забывчивость. Наличие и условия Android-SDK у
 * Яндекс ID, T-ID, Сбер ID и VK ID — **не проверено**: это действие
 * человека (12_NATIVE_AUTH.md §6), а не агента. До ответа по каждому
 * провайдеру он на мобильном экране не показывается — так требует
 * §2.2, и это следствие требования, а не ошибка.
 *
 * Вход по коду из письма доступен всегда (И-5).
 */
const NATIVE_SDK_READY: ReadonlySet<Provider> = new Set<Provider>();

/**
 * Провайдеры, подключённые для веба (OIDC с редиректом).
 *
 * Тоже пусто на Э2: договоры и регистрация приложений у Яндекс ID,
 * T-ID, Сбер ID и VK ID — действие человека. Подключение внешних
 * провайдеров вынесено в Э5 (docs/plan/E2.md, «Границы этого плана»).
 * Экран входа обязан не разваливаться при любом их числе, включая ноль,
 * и это закрыто тестом.
 */
const WEB_PROVIDERS_READY: ReadonlySet<Provider> = new Set<Provider>();

export function isMobilePlatform(platform: string): boolean {
  return platform === "android" || platform === "ios";
}

export async function availableProviders(platform: string): Promise<Provider[]> {
  const ready = isMobilePlatform(platform) ? NATIVE_SDK_READY : WEB_PROVIDERS_READY;
  return PROVIDERS.filter((p) => ready.has(p));
}

export function hasNativeSdk(provider: string): boolean {
  return NATIVE_SDK_READY.has(provider as Provider);
}
