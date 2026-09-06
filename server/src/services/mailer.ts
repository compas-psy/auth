import { logger } from "../lib/logging.js";

/**
 * Отправка писем.
 *
 * Магические ссылки и коды уходят с единого отправителя экосистемы —
 * того же, с которого уже отправляют ЗАПИСКИ (02_SIMPASID.md §6.5).
 * Настройка DNS и почтового отправителя — действие человека, не агента
 * (CLAUDE.md, «Что делает человек»), поэтому здесь только точка
 * подключения: транспорт задаётся переменными окружения на сервере.
 *
 * НЕ ПРОВЕРЕНО: селектор DKIM домена cmpas.ru — запись, названная в
 * плане (default._domainkey.mail.cmpas.ru), не отвечает.
 * Способ проверки — в docs/reports/E2/00-предусловия.md.
 *
 * Ни адрес, ни код, ни токен в журнал не попадают (У-9).
 */
export async function sendEmailCode(email: string, code: string): Promise<void> {
  await deliver({ to: email, kind: "email_code", body: code });
}

export async function sendMagicLink(email: string, url: string): Promise<void> {
  await deliver({ to: email, kind: "magic_link", body: url });
}

async function deliver(msg: { to: string; kind: string; body: string }): Promise<void> {
  const endpoint = process.env.MAIL_ENDPOINT;
  if (!endpoint) {
    // Отправителя нет — письмо не уходит, и это видно в журнале
    // событием, а не тишиной. Вход при этом не падает: человек
    // увидит экран «Проверьте почту», письма не дождётся и повторит.
    logger.warn({ event: "mail_not_configured", kind: msg.kind });
    return;
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MAIL_TOKEN ? { authorization: `Bearer ${process.env.MAIL_TOKEN}` } : {}),
      },
      body: JSON.stringify(msg),
    });
    logger.info({ event: "mail_sent", kind: msg.kind, ok: res.ok });
  } catch {
    logger.error({ event: "mail_send", kind: msg.kind, outcome: "fail" });
  }
}
