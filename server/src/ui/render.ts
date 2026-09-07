import { escapeHtml } from "./escape.js";
import { signIn, checkEmail, enterCode, emailRequired, errors } from "./wording.js";

export interface ScreenState {
  [key: string]: unknown;
}

/**
 * Отдача экрана взаимодействия.
 *
 * Сервер отдаёт оболочку, состояние и — сразу разметкой — те тексты,
 * которые несут юридическую нагрузку: заголовок, строку про внешний
 * сервис и юридическую строку с названной редакцией. Дальше их
 * перерисовывает портал теми же формулировками из того же реестра.
 *
 * Почему юридическая строка приходит разметкой, а не только состоянием:
 * акцепт совершается ДЕЙСТВИЕМ, и в момент действия человек обязан
 * видеть, что именно он принимает. Экран, на котором эта строка
 * появляется только после исполнения скрипта, при отказе скрипта
 * оставляет кнопку без указания на документ — а это уже дефект
 * правовой конструкции, а не деталь вёрстки.
 */
export function renderScreen(screen: string, state: ScreenState): string {
  const payload = JSON.stringify({ screen, ...state })
    // </script> внутри строки закрыл бы тег раньше времени.
    .replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(TITLES[screen] ?? "Вход в СИМПАС")}</title>
<link rel="stylesheet" href="/assets/portal.css">
</head>
<body>
<div id="root">${noScriptBody(screen, state)}</div>
<script id="state" type="application/json">${payload}</script>
<script type="module" src="/assets/portal.js"></script>
</body>
</html>`;
}

const TITLES: Record<string, string> = {
  SignIn: "Вход в СИМПАС",
  CheckEmail: "Проверьте почту",
  EnterCode: "Введите код из письма",
  EmailRequired: "Нужна электронная почта",
  LinkExpired: "Ссылка больше не действует",
  Unavailable: "Вход временно недоступен",
  IdentityTaken: "Этот аккаунт уже привязан",
  ProviderFailed: "Войти не получилось",
};

const PROVIDER_TITLES: Record<string, string> = {
  yandex: "Яндекс ID", tid: "T-ID", sberid: "Сбер ID", vkid: "VK ID",
};

function noScriptBody(screen: string, state: ScreenState): string {
  if (screen === "SignIn") {
    const version = String(state.termsVersion ?? "0.9");
    const service = String(state.service ?? "practice") as keyof typeof SERVICE_TITLES;
    return `<div class="screen"><main class="card">
<p class="brand">${escapeHtml(signIn.brand)}</p>
<h1>${escapeHtml(SERVICE_TITLES[service] ?? SERVICE_TITLES.practice)}</h1>
<p class="subtitle">${escapeHtml(signIn.subtitle)}</p>
<p class="provider-notice">${escapeHtml(signIn.providerNotice)}</p>
${legalLine(version)}
</main></div>`;
  }
  // Экран C4: человеческий текст, а не техническая ошибка. Отдаётся
  // разметкой, потому что при нездоровом сервисе скрипт может и
  // не загрузиться — а сказать человеку, что происходит, надо.
  if (screen === "Unavailable") {
    return `<div class="screen"><main class="card" role="alert">
<h1>${escapeHtml(errors.unavailableTitle)}</h1>
<p class="subtitle">${escapeHtml(errors.unavailable)}</p>
</main></div>`;
  }
  if (screen === "IdentityTaken") {
    return `<div class="screen"><main class="card" role="alert">
<h1>${escapeHtml(errors.identityTakenTitle)}</h1>
<p class="subtitle">${escapeHtml(errors.identityTaken)}</p>
</main></div>`;
  }
  if (screen === "ProviderFailed") {
    return `<div class="screen"><main class="card" role="alert">
<h1>Войти этим способом не получилось</h1>
<p class="subtitle">Попробуйте ещё раз или войдите по почте.</p>
</main></div>`;
  }
  if (screen === "EmailRequired") {
    const provider = String(state.provider ?? "yandex");
    const name = PROVIDER_TITLES[provider] ?? "Внешний сервис";
    return `<div class="screen"><main class="card">
<h1>${escapeHtml(emailRequired.title)}</h1>
<p class="subtitle">${escapeHtml(name)} не передал подтверждённый адрес почты.
Почта нужна, чтобы вы могли войти, даже если доступ к ${escapeHtml(name)} пропадёт.</p>
</main></div>`;
  }
  if (screen === "LinkExpired") {
    return `<div class="screen"><main class="card" role="alert">
<h1>Ссылка больше не действует</h1>
<p class="subtitle">Ссылка открывается один раз и живёт 15 минут. Запросите новую.</p>
</main></div>`;
  }
  return "";
}

const SERVICE_TITLES = {
  practice: signIn.title("practice"),
  zapiski: signIn.title("zapiski"),
  moments: signIn.title("moments"),
} as const;

/**
 * Юридическая строка: два предложения, две разные ссылки, обе — на
 * КОНКРЕТНУЮ редакцию. Глагола принятия применительно к Политике нет.
 */
function legalLine(version: string): string {
  const v = escapeHtml(version);
  return `<p class="legal" data-testid="legal-line">Продолжая, вы принимаете ` +
    `<a href="/legal/terms/${v}">${escapeHtml(signIn.legalTermsLinkText)}</a>, ` +
    `редакция ${v}. Как мы обращаемся с данными — в ` +
    `<a href="/legal/privacy/${v}">${escapeHtml(signIn.legalPrivacyLinkText)}</a>.</p>`;
}

export { checkEmail, enterCode, emailRequired, errors };
