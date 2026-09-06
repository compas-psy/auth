/**
 * Огрубление user-agent до семейства платформы и клиента БЕЗ версии.
 *
 * Решение П-2 от 06.09.2026: эти два поля показываются человеку на
 * экране «Устройства и сеансы». Полный user-agent при этом не хранится
 * нигде — только его хеш, и то в журнале.
 *
 * Версии отбрасываются намеренно: «Chrome 131.0.6778.86» опознаёт
 * устройство точнее, чем нужно для ответа на вопрос «это я или не я».
 */
export interface CoarseDevice {
  platform: string | null;
  client: string | null;
}

export function coarsen(userAgent: string | undefined | null): CoarseDevice {
  if (!userAgent) return { platform: null, client: null };
  const ua = userAgent.toLowerCase();

  const platform =
    ua.includes("android") ? "android"
    : /iphone|ipad|ios/.test(ua) ? "ios"
    : ua.includes("windows") ? "windows"
    : /macintosh|mac os x/.test(ua) ? "macos"
    : ua.includes("linux") ? "linux"
    : null;

  // Порядок проверок значим: Edge и Opera представляются Chrome,
  // Chrome представляется Safari. Сначала частное, потом общее.
  const client =
    /edg\//.test(ua) ? "edge"
    : /opr\/|opera/.test(ua) ? "opera"
    : /yabrowser/.test(ua) ? "yandex"
    : /firefox/.test(ua) ? "firefox"
    : /chrome|crios/.test(ua) ? "chrome"
    : /safari/.test(ua) ? "safari"
    : null;

  return { platform, client };
}
