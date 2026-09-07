import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { logger } from "../src/lib/logging.js";

/**
 * Отправка писем.
 *
 * Единый отправитель экосистемы — тот же локальный релей, через
 * который уже шлют ЗАПИСКИ (02_SIMPASID.md §6.5). Их же граблями
 * ходить не будем: см. комментарий в mailer.ts.
 */

const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_LOCAL_RELAY", "MAIL_FROM", "MAIL_ENDPOINT", "MAIL_TOKEN"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  // Транспорт кэшируется на весь процесс, а окружение здесь меняется
  // от теста к тесту.
  (await import("../src/services/mailer.js")).resetMailer();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** Минимальный SMTP-собеседник: принимает письмо и отдаёт его целиком. */
function fakeSmtp(): Promise<{ port: number; server: Server; letter: Promise<string> }> {
  let resolveLetter: (v: string) => void;
  const letter = new Promise<string>((r) => { resolveLetter = r; });
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let data = "";
      let inData = false;
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            inData = false;
            resolveLetter(data);
            socket.write("250 OK\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 SIZE 10240000\r\n");
          else if (cmd === "MAIL" || cmd === "RCPT") socket.write("250 OK\r\n");
          else if (cmd === "DATA") { inData = true; socket.write("354 send it\r\n"); }
          else if (cmd === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
          else socket.write("250 OK\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as { port: number }).port, server, letter });
    });
  });
}

/**
 * Тело письма с кириллицей уходит закодированным — base64 или
 * quoted-printable. Ищем в расшифрованном: иначе тест проверял бы
 * кодировку, а не содержание.
 */
function letterText(raw: string): string {
  const split = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, split);
  const body = raw.slice(split + 4).replace(/\r\n\.\r\n[\s\S]*$/, "");
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

describe("письмо доходит до релея", () => {
  it("ссылка для входа уходит настоящим письмом", async () => {
    const { port, server, letter } = await fakeSmtp();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(port);
    process.env.MAIL_FROM = "СИМПАС <noreply@cmpas.ru>";

    const { sendMagicLink } = await import("../src/services/mailer.js");
    await sendMagicLink("человек@ya.ru", "https://auth.cmpas.ru/interaction/u/callback?token=Т");

    const text = letterText(await letter);
    server.close();
    expect(text).toContain("auth.cmpas.ru/interaction/u/callback?token=Т");
    // Человек читает письмо, а не спецификацию.
    for (const word of ["токен", "OIDC", "authorization", "magic"]) {
      expect({ word, found: text.toLowerCase().includes(word.toLowerCase()) })
        .toEqual({ word, found: false });
    }
  });

  it("код из письма уходит письмом же", async () => {
    const { port, server, letter } = await fakeSmtp();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(port);

    const { sendEmailCode } = await import("../src/services/mailer.js");
    await sendEmailCode("человек@ya.ru", "482915");

    const text = letterText(await letter);
    server.close();
    expect(text).toContain("482915");
    // Код даёт вход: письмо обязано это сказать.
    expect(text).toContain("Никому его не сообщайте");
  });
});

describe("журнал не выдаёт ни адреса, ни секрета", () => {
  it("ни почта, ни код, ни ссылка в журнал не попадают", async () => {
    // У-9. Письмо содержит одноразовый ключ входа: строка журнала с
    // ним равносильна выданному доступу.
    const written: string[] = [];
    vi.spyOn(logger, "info").mockImplementation(((o: unknown) => { written.push(JSON.stringify(o)); }) as never);
    vi.spyOn(logger, "warn").mockImplementation(((o: unknown) => { written.push(JSON.stringify(o)); }) as never);
    vi.spyOn(logger, "error").mockImplementation(((o: unknown) => { written.push(JSON.stringify(o)); }) as never);

    const { port, server, letter } = await fakeSmtp();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(port);

    const { sendEmailCode } = await import("../src/services/mailer.js");
    await sendEmailCode("человек@ya.ru", "482915");
    await letter;
    server.close();

    const dump = written.join("\n");
    for (const secret of ["человек@ya.ru", "482915", "ya.ru"]) {
      expect({ secret, found: dump.includes(secret) }).toEqual({ secret, found: false });
    }
    expect(dump).toContain("mail_sent");
  });
});

describe("когда отправителя нет", () => {
  it("вход не падает, а в журнале остаётся след", async () => {
    const written: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation(((o: unknown) => { written.push(JSON.stringify(o)); }) as never);
    const { sendMagicLink } = await import("../src/services/mailer.js");
    await expect(sendMagicLink("н@ya.ru", "https://x")).resolves.toBeUndefined();
    expect(written.join()).toContain("mail_not_configured");
  });

  it("недоступный релей не роняет вход", async () => {
    // Человек увидит «Проверьте почту», письма не дождётся и повторит.
    // Это лучше, чем ошибка на экране входа.
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1";
    const { sendMagicLink } = await import("../src/services/mailer.js");
    await expect(sendMagicLink("н@ya.ru", "https://x")).resolves.toBeUndefined();
  });
});
