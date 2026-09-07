import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../lib/logging.js";
import { letters } from "../ui/wording.js";

/**
 * Отправка писем.
 *
 * Единый отправитель экосистемы (02_SIMPASID.md §6.5): тот же локальный
 * релей, через который уже шлют ЗАПИСКИ. Это ЕДИНСТВЕННАЯ наша
 * зависимость от чужого контейнера, и она предписана спецификацией, а
 * не выбрана для удобства: доменная репутация набирается месяцами и
 * портится за дни, а два отправителя на одном домене её и портят.
 *
 * Релей недоступен — вход по почте не работает, вход через провайдера
 * работает. Ронять сервис из-за письма нельзя.
 *
 * Ни адрес, ни код, ни ссылка в журнал не попадают (У-9): строка
 * журнала с ключом входа равносильна выданному доступу.
 */

let cached: Transporter | null = null;

/**
 * Транспорт.
 *
 * ГРАБЛИ, НА КОТОРЫЕ УЖЕ НАСТУПИЛИ ЗАПИСКИ (их server/src/services/
 * mailer.ts, комментарий к localRelayWithoutCertificate) — повторять
 * не будем.
 *
 * Релей стоит на этой же машине, зовётся host.docker.internal и
 * предъявляет самоподписанный сертификат: имени такого в сертификате
 * нет и быть не может. На порту 25 при secure: false nodemailer ВСЁ
 * РАВНО поднимает STARTTLS, если сервер его объявляет, и проверяет
 * личность строго. Проверка падает — и живой релей выглядит
 * недоступным.
 *
 * Поэтому для ЛОКАЛЬНОГО релея:
 *   • rejectUnauthorized: false — рукопожатие проходит, трафик остаётся
 *     шифрованным, не проверяется только личность собеседника;
 *   • opportunisticTLS — если релей вовсе откажет на STARTTLS, разговор
 *     продолжится, а не оборвётся.
 *
 * Второе без первого не помогает: opportunisticTLS ловит ОТКАЗ на
 * команду, а провал рукопожатия — нет.
 *
 * Умолчание — строгая проверка. Для релея за пределами машины подменить
 * собеседника есть кому.
 */
function transport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  if (cached) return cached;

  const local = process.env.SMTP_LOCAL_RELAY === "true";
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 25),
    secure: process.env.SMTP_SECURE === "true",
    ...(local ? { opportunisticTLS: true, tls: { rejectUnauthorized: false } } : {}),
    ...(user && password ? { auth: { user, pass: password } } : {}),
  });
  return cached;
}

/** Только для тестов: транспорт кэшируется, окружение в них меняется. */
export function resetMailer(): void {
  cached = null;
}

export async function sendEmailCode(email: string, code: string): Promise<void> {
  await deliver({
    to: email, kind: "email_code",
    subject: letters.codeSubject, text: letters.code(code), body: code,
  });
}

export async function sendMagicLink(email: string, url: string): Promise<void> {
  await deliver({
    to: email, kind: "magic_link",
    subject: letters.magicLinkSubject, text: letters.magicLink(url), body: url,
  });
}

interface Message {
  to: string;
  kind: string;
  subject: string;
  text: string;
  /** Для HTTP-отправителя, который сам собирает письмо. */
  body: string;
}

async function deliver(msg: Message): Promise<void> {
  const smtp = transport();
  if (smtp) {
    try {
      await smtp.sendMail({
        from: process.env.MAIL_FROM ?? "СИМПАС <noreply@cmpas.ru>",
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
      logger.info({ event: "mail_sent", kind: msg.kind, transport: "smtp" });
    } catch {
      // Причина не пишется: в тексте ошибки транспорта бывает и адрес,
      // и имя хоста релея.
      logger.error({ event: "mail_send", kind: msg.kind, outcome: "fail", transport: "smtp" });
    }
    return;
  }

  // Запасной путь: внешний отправитель по HTTP, если он когда-нибудь
  // появится вместо релея.
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
      body: JSON.stringify({ to: msg.to, kind: msg.kind, body: msg.body }),
    });
    logger.info({ event: "mail_sent", kind: msg.kind, transport: "http", ok: res.ok });
  } catch {
    logger.error({ event: "mail_send", kind: msg.kind, outcome: "fail", transport: "http" });
  }
}
