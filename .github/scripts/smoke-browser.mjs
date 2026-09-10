/**
 * Сквозная проверка В БРАУЗЕРЕ на собранном образе.
 *
 * Зачем она есть. Весь остальной набор ходит через app.inject — вызов
 * обработчика в том же процессе. За один день три дефекта доехали до
 * боевого сервера мимо зелёных проверок, и каждый ловился только живым
 * браузером:
 *
 *   1. cookie взаимодействия не доезжала до /callback/yandex — проверки
 *      не знали, что браузер отбирает cookie по Path;
 *   2. портал не мог обменять код на ключ — проверки не слали Origin,
 *      а браузер шлёт его на КАЖДЫЙ POST;
 *   3. кнопки в кабинете «не нажимались» — экран не следовал адресу.
 *
 * Что здесь поднимается и почему.
 *
 *   TLS. Cookie с префиксом __Host- браузер принимает только по https.
 *   По http вход не начинается вовсе, и проверка проверяла бы не то.
 *
 *   Приёмник почты. Вход по ссылке — единственный путь, не требующий
 *   внешнего провайдера. Письмо перехватывается, ссылка из него
 *   открывается браузером — ровно как это сделал бы человек.
 */
import { chromium } from "playwright";
import { createServer as createTlsServer } from "node:https";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_PORT = Number(process.env.SMOKE_APP_PORT ?? 3001);
const TLS_PORT = Number(process.env.SMOKE_TLS_PORT ?? 8443);
const SMTP_PORT = Number(process.env.SMOKE_SMTP_PORT ?? 1025);
const BASE = `https://127.0.0.1:${TLS_PORT}`;
/**
 * Адрес уникален на каждый прогон. Повторный запрос ссылки на тот же
 * адрес попадает под паузу, и проверка стала бы зависеть от истории:
 * первый раз зелёная, второй — красная без единой правки в коде.
 */
const WHO = `smoke-${Date.now()}@ya.ru`;

function fail(what) {
  console.error(`::error::${what}`);
  process.exitCode = 1;
  throw new Error(what);
}

/** Самоподписанный сертификат — только для этой проверки. */
function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), "smoke-tls-"));
  const key = join(dir, "k.pem");
  const cert = join(dir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function startTls() {
  const server = createTlsServer(makeCert(), (req, res) => {
    const up = httpRequest(
      { host: "127.0.0.1", port: APP_PORT, path: req.url, method: req.method,
        headers: { ...req.headers, "x-forwarded-proto": "https" } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
    );
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  });
  return new Promise((ok) => server.listen(TLS_PORT, "127.0.0.1", () => ok(server)));
}

/** Минимальный приёмник SMTP: письма складываются в массив. */
function startSmtp(letters) {
  const server = createNetServer((socket) => {
    let inData = false;
    let body = "";
    socket.write("220 smoke\r\n");
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (inData) {
        body += text;
        if (body.includes("\r\n.\r\n")) {
          letters.push(body);
          inData = false; body = "";
          socket.write("250 ok\r\n");
        }
        return;
      }
      for (const line of text.split("\r\n").filter(Boolean)) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-smoke\r\n250 OK\r\n");
        else if (cmd === "DATA") { inData = true; socket.write("354 send\r\n"); }
        else if (cmd === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((ok) => server.listen(SMTP_PORT, "127.0.0.1", () => ok(server)));
}

/**
 * Ссылка из письма.
 *
 * Тело приходит закодированным: nodemailer выбирает base64 для текста
 * с кириллицей и quoted-printable для остального. Разбираем оба —
 * иначе проверка краснеет не потому, что вход сломан, а потому что мы
 * не умеем читать собственное письмо.
 */
function linkFrom(letter) {
  const split = letter.indexOf("\r\n\r\n");
  const headers = split > 0 ? letter.slice(0, split) : "";
  let body = split > 0 ? letter.slice(split + 4) : letter;
  body = body.replace(/\r\n\.\r\n[\s\S]*$/, "");

  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    body = Buffer.from(body.replace(/\r?\n/g, ""), "base64").toString("utf8");
  } else {
    body = body.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  }
  const m = /https:\/\/127\.0\.0\.1:\d+\/interaction\/[^\s"'<>]+/.exec(body);
  return m ? m[0] : null;
}

const letters = [];
const smtp = await startSmtp(letters);
const tls = await startTls();
console.log(`приёмник почты на ${SMTP_PORT}, TLS на ${TLS_PORT}`);

// В прогоне Chromium ставится обычным способом; на машине разработчика
// он может лежать в другом месте — тогда путь передаётся переменной.
const browser = await chromium.launch(
  process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {},
);
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`ошибка страницы: ${e}`));
page.on("response", (r) => {
  if (r.status() >= 500) problems.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
});

try {
  // 1. Человек открывает кабинет и попадает на экран входа.
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  const emailField = page.locator('input[type="email"]');
  if (!(await emailField.count())) fail("экран входа не открылся: нет поля почты");

  // 2. Просит письмо.
  await emailField.first().fill(WHO);
  await page.locator('button[type="submit"]').first().click();

  for (let i = 0; i < 60 && letters.length === 0; i++) {
    await page.waitForTimeout(500);
  }
  if (letters.length === 0) fail("письмо со ссылкой не ушло");

  const link = linkFrom(letters[letters.length - 1]);
  if (!link) fail("в письме нет ссылки для входа");

  // 3. Переходит по ссылке — и обязан оказаться В КАБИНЕТЕ.
  //
  // Ждём загрузку разметки, а не «сеть затихла»: при сломанном обмене
  // кода запросы висят, networkidle не наступает, и проверка падает
  // таймаутом вместо объяснения. Отказ должен читаться с первой строки.
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const heading = await page.locator("h1").first().innerText().catch(() => "");
  if (heading !== "Аккаунт СИМПАС") {
    console.error(`::error::после входа ожидался кабинет, а на экране: «${heading}»`);
    console.error(`адрес: ${page.url()}`);
    const body = await page.locator("body").innerText().catch(() => "");
    console.error(`что видит человек: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
    process.exitCode = 1;
  } else {
    console.log("OK: вход по ссылке доводит до кабинета.");
  }

  // 4. Переходы внутри кабинета работают без перезагрузки.
  const card = page.locator('a[href="/account/communications"]');
  if (await card.count()) {
    await card.first().click();
    await page.waitForTimeout(1500);
    const section = await page.locator("h1").first().innerText().catch(() => "");
    if (section !== "Коммуникации") {
      console.error(`::error::нажатие карточки не открыло раздел: «${section}»`);
      process.exitCode = 1;
    } else {
      console.log("OK: разделы кабинета открываются.");
    }
  } else {
    console.error("::error::в кабинете нет карточки «Коммуникации»");
    process.exitCode = 1;
  }
} finally {
  if (problems.length) {
    console.error("::error::страница жаловалась:");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  }
  await browser.close();
  tls.close();
  smtp.close();
}
