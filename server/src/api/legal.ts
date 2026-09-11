import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { escapeHtml } from "../ui/escape.js";
import { renderLegalMarkdown } from "../ui/markdown.js";
import { readLegalText, isTampered } from "../services/legalTexts.js";
import { PRODUCT_NAMES, PRODUCT_HOME, type ProductCode } from "../ui/wording.js";

interface DocumentVersion {
  code: string;
  title: string;
  acceptance: string;
  version: string;
  effective_at: Date;
  content_hash: string;
  immutable_url: string;
  current_version: string | null;
}

/**
 * Консент-центр: тексты, реестры, неизменяемые адреса редакций.
 *
 * Требование юрпакета §11 и задания 08 §2.4: ссылка ведёт на
 * КОНКРЕТНУЮ редакцию, а не на текущую. Человек, принявший
 * соглашение в редакции 0.9, обязан иметь возможность посмотреть
 * именно её — даже когда действует уже 1.0.
 *
 * Адрес редакции не собирается из частей пути, а ищется в реестре
 * целиком: подстановка кода и версии в шаблон открыла бы дорогу
 * обходу каталогов и выдаче чужого документа под нужным адресом.
 */
export async function registerLegalRoutes(app: FastifyInstance): Promise<void> {
  // Реестры стоят ПЕРВЫМИ и обслуживаются точным совпадением: иначе
  // /legal/services искался бы среди документов и давал 404.
  app.get("/legal/services", async (_req, reply) =>
    html(reply, await servicesPage()));

  app.get("/legal/processors", async (_req, reply) =>
    html(reply, processorsPage()));

  app.get<{ Params: { "*": string } }>("/legal/*", async (req, reply) => {
    const tail = req.params["*"];

    // Исходник, по которому считается отпечаток. Отдаётся как есть,
    // чтобы совпадение хеша мог проверить кто угодно, не имея доступа
    // к базе, — иначе «отпечаток» приходится принимать на веру.
    if (tail.endsWith(".txt")) {
      const doc = await findVersion(`/legal/${tail.slice(0, -4)}`);
      const text = doc && readLegalText(doc.code, doc.version);
      if (!doc || !text || isTampered(doc.code, doc.version)) {
        return html(reply.code(404), notFoundPage());
      }
      return reply
        .type("text/plain; charset=utf-8")
        .header("cache-control", "public, max-age=86400, immutable")
        .send(text.source);
    }

    const doc = await findVersion(`/legal/${tail}`);
    if (doc) {
      return reply
        .type("text/html; charset=utf-8")
        // Редакция неизменяема по определению: её можно кэшировать надолго.
        .header("cache-control", "public, max-age=86400, immutable")
        .send(documentPage(doc));
    }

    // Перечень редакций документа: /legal/terms. Он нужен на каждой
    // странице редакции (§5.6), иначе из «своей» редакции некуда выйти.
    const versions = await listVersions(`/legal/${tail}/`);
    if (versions.length) return html(reply, versionsPage(versions));

    return html(reply.code(404), notFoundPage());
  });
}

async function findVersion(url: string): Promise<DocumentVersion | null> {
  const { rows } = await getPool().query<DocumentVersion>(
    `SELECT v.code, d.title, d.acceptance, d.current_version, v.version,
            v.effective_at, v.content_hash, v.immutable_url
     FROM legal_document_versions v
     JOIN legal_documents d ON d.code = v.code
     WHERE v.immutable_url = $1`,
    [url],
  );
  return rows[0] ?? null;
}

async function listVersions(prefix: string): Promise<DocumentVersion[]> {
  const { rows } = await getPool().query<DocumentVersion>(
    `SELECT v.code, d.title, d.acceptance, d.current_version, v.version,
            v.effective_at, v.content_hash, v.immutable_url
     FROM legal_document_versions v
     JOIN legal_documents d ON d.code = v.code
     WHERE v.immutable_url LIKE $1 || '%'
     ORDER BY v.effective_at DESC, v.version DESC`,
    [prefix],
  );
  return rows;
}

/** Адрес перечня редакций: у /legal/terms/0.9 это /legal/terms. */
function indexUrl(doc: DocumentVersion): string {
  return doc.immutable_url.slice(0, doc.immutable_url.lastIndexOf("/"));
}

function documentPage(doc: DocumentVersion): string {
  const effective = formatDate(doc.effective_at);
  const index = indexUrl(doc);
  // content_hash = PENDING означает, что текст ещё не опубликован в
  // сервис. Молчать об этом нельзя: доказательством согласия служит
  // связка «редакция + хеш того, что человек видел».
  const published = doc.content_hash !== "PENDING";
  const text = readLegalText(doc.code, doc.version);
  const tampered = isTampered(doc.code, doc.version);

  const textBlock = tampered
    ? `<p class="notice">Текст этой редакции не показывается: файл на сервере
       разошёлся с отпечатком, под которым редакция опубликована.
       Опубликованная редакция не правится — расхождение разбирается,
       а не показывается как документ.</p>`
    : text
      ? `<div class="doc">${renderLegalMarkdown(text.source)}</div>`
      : `<p class="notice">Текст этой редакции ещё не опубликован в консент-центре.</p>`;

  const hashBlock = published && !tampered
    ? `<p class="muted">Отпечаток текста (SHA-256):
       <code>${escapeHtml(doc.content_hash)}</code>
       ${text ? `· <a href="${escapeHtml(doc.immutable_url)}.txt">исходник, по которому он посчитан</a>` : ""}</p>`
    : `<p class="notice">Отпечаток текста этой редакции ещё не подтверждён.
       Пока это так, принятие этой редакции доказывается записью о
       событии, но не текстом.</p>`;

  // Политика не принимается вовсе — и это сказано на ней самой, а не
  // только в реестре (ТЗ §5.6 и §8.6).
  const acceptanceBlock = doc.acceptance === "none"
    ? `<p class="notice">Это информационный документ. Принимать его не нужно —
       ни кнопкой, ни отметкой, ни «ознакомлен».</p>`
    : "";

  const currentBlock = doc.current_version && doc.current_version !== doc.version
    ? `<p class="muted">Действует более новая редакция:
       <a href="${escapeHtml(index)}/${escapeHtml(doc.current_version)}">${escapeHtml(doc.current_version)}</a>.</p>`
    : `<p class="muted">Это действующая редакция документа.</p>`;

  return page(`${doc.title}, редакция ${doc.version}`, `
<p class="eyebrow">Документ СИМПАС</p>
<h1>${escapeHtml(doc.title)}</h1>
<p class="version">редакция ${escapeHtml(doc.version)} · код <code>${escapeHtml(doc.code)}</code></p>
<p class="muted">Действует с ${escapeHtml(effective)}.</p>
${acceptanceBlock}
${currentBlock}
${hashBlock}
<p class="muted">Это постоянный адрес именно этой редакции. Он не меняется,
даже когда выходит новая. <a href="${escapeHtml(index)}">Все редакции этого документа</a>.</p>
${textBlock}`, "wide");
}

function versionsPage(versions: DocumentVersion[]): string {
  const doc = versions[0]!;
  const rows = versions.map((v) => {
    const mark = v.version === doc.current_version ? " · действующая" : "";
    return `<li><a href="${escapeHtml(v.immutable_url)}">редакция ${escapeHtml(v.version)}</a>
      <span class="muted">с ${escapeHtml(formatDate(v.effective_at))}${mark}</span></li>`;
  }).join("");

  return page(`${doc.title}: редакции`, `
<p class="eyebrow">Редакции документа</p>
<h1>${escapeHtml(doc.title)}</h1>
<p class="muted">Код <code>${escapeHtml(doc.code)}</code>. Каждая редакция остаётся
доступной по своему адресу навсегда: по ней есть принятия, и они должны
оставаться доказуемыми.</p>
<ul class="rows">${rows}</ul>`);
}

/**
 * Реестр сервисов Экосистемы — обещание Пользовательского соглашения
 * (п. 1.2) и требование пакета §2. Документ ссылался на страницу,
 * которой не существовало.
 *
 * Без версии, без принятия, всегда актуальный: это перечень фактов.
 * Состояние берётся из того же места, что и кабинет, — сервис с
 * известным адресом работает, остальные готовятся. Выдумывать
 * состояние здесь нельзя: реестр, расходящийся с действительностью,
 * хуже отсутствующего.
 */
async function servicesPage(): Promise<string> {
  const { rows } = await getPool().query<{ product: ProductCode; code: string; current_version: string | null }>(
    "SELECT product, code, current_version FROM legal_documents WHERE product IS NOT NULL");
  const byProduct = new Map(rows.map((r) => [r.product, r]));

  const items = (Object.keys(PRODUCT_NAMES) as ProductCode[]).map((code) => {
    const doc = byProduct.get(code);
    const live = PRODUCT_HOME[code] !== null;
    const terms = doc?.current_version
      ? `<a href="/legal/${slugFor(doc.code)}/${escapeHtml(doc.current_version)}">Особые условия</a>`
      : `<span class="muted">Особые условия ещё не опубликованы</span>`;
    return `<li>
      <span class="row-title">${escapeHtml(PRODUCT_NAMES[code])}</span>
      <span class="muted">${live ? "работает" : "готовится"} · ${terms}</span>
      <span class="muted">${escapeHtml(DATA_DOMAIN[code])}</span>
    </li>`;
  }).join("");

  return page("Реестр сервисов СИМПАС", `
<p class="eyebrow">Реестр СИМПАС</p>
<h1>Реестр сервисов</h1>
<p class="muted">Перечень сервисов Экосистемы СИМПАС. Страница без редакций и без
принятия: она всегда актуальна. Оператор всех сервисов один —
ИП Мартынов Илья Николаевич.</p>
<ul class="rows">${items}</ul>
<p class="muted">Сервис появляется здесь в тот же момент, когда становится доступен
человеку. У каждого сервиса свои Особые условия, а Политика обработки
персональных данных — <a href="/legal/privacy">одна на всю Экосистему</a>:
она описывает оператора, а не продукт.</p>`, "wide");
}

/** Короткое описание домена данных сервиса — факт, а не обещание. */
const DATA_DOMAIN: Record<ProductCode, string> = {
  practice: "записи психолога о практике и её клиентах",
  zapiski: "зашифрованные заметки; ключ хранилища сервису неизвестен",
  moments: "материалы, которые человек добавляет сам",
  steps: "состав данных будет назван вместе с Особыми условиями",
};

function slugFor(code: string): string {
  // Адрес документа известен реестру редакций; для документа без
  // опубликованной редакции ссылки всё равно не будет.
  return code.replace(/^cmpas_/, "").replace(/_/g, "-");
}

/**
 * Реестр обработчиков — обещание центральной Политики §7.2.
 *
 * По КАТЕГОРИЯМ. Наименования обработчиков и статус договоров с ними
 * публикуются только после подтверждения учредителем (ТЗ §5.5):
 * заявление «с этим обработчиком у нас оформлено поручение»
 * проверяемо, и ошибиться в нём нельзя. Категории исполняют обещание
 * Политики уже сейчас.
 *
 * Состав собран из 05_CONSENT_PDN.md §1.6 — то есть из переменных
 * окружения и кода продуктов, а не из представлений о том, как
 * устроено.
 */
function processorsPage(): string {
  const items = PROCESSOR_CATEGORIES.map((c) => `<li>
    <span class="row-title">${escapeHtml(c.title)}</span>
    <span class="muted">${escapeHtml(c.purpose)}</span>
    <span class="muted">Передаётся: ${escapeHtml(c.data)}</span>
  </li>`).join("");

  return page("Реестр обработчиков СИМПАС", `
<p class="eyebrow">Реестр СИМПАС</p>
<h1>Реестр обработчиков и внешних сервисов</h1>
<p class="muted">Перечень категорий внешних обработчиков, которые участвуют в работе
сервисов Экосистемы, и состава данных, который им передаётся. Страница
без редакций и без принятия.</p>
<ul class="rows">${items}</ul>
<p class="notice">Наименования конкретных обработчиков и сведения о заключённых с ними
поручениях на обработку публикуются здесь по мере подтверждения. До тех
пор названы категории и состав передаваемых данных.</p>
<p class="muted">Подробнее о том, зачем и на каком основании обрабатываются данные, —
в <a href="/legal/privacy">Политике обработки персональных данных</a>.</p>`, "wide");
}

const PROCESSOR_CATEGORIES = [
  { title: "Хостинг и инфраструктура",
    purpose: "размещение сервисов и хранение данных",
    data: "всё, что хранится в сервисах" },
  { title: "Доставка писем",
    purpose: "письма со ссылкой для входа и служебные уведомления",
    data: "адрес получателя и содержание письма" },
  { title: "Вход через провайдеров",
    purpose: "вход по учётной записи внешнего провайдера",
    data: "адрес электронной почты и идентификатор учётной записи у провайдера" },
  { title: "Платежи",
    purpose: "приём оплаты",
    data: "платёжные данные и номер заказа" },
  { title: "Мессенджеры",
    purpose: "сообщения между психологом и его клиентом",
    data: "текст сообщений и идентификатор получателя в мессенджере" },
  { title: "Аналитика",
    purpose: "измерение поведения на сайте",
    data: "действия на страницах сайта" },
  { title: "Определение геоданных",
    purpose: "приблизительное определение региона по сетевому адресу",
    data: "сетевой адрес посетителя" },
  { title: "Подсказки адресов",
    purpose: "подстановка адреса при заполнении формы",
    data: "строка адреса, которую вводит человек" },
] as const;

function notFoundPage(): string {
  return page("Документ не найден", `
<h1>Документ не найден</h1>
<p class="muted">Такой редакции у нас нет. Возможно, ссылка набрана с опечаткой.</p>
<p><a class="primary" href="/legal/services">Реестр сервисов</a></p>`);
}

function formatDate(value: Date): string {
  // Хвост «г.» убирается: дальше по тексту идёт точка предложения, и
  // на странице получалось «с 3 сентября 2026 г..».
  return value
    .toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    .replace(/\s*г\.$/, "");
}

function html(reply: { type: (v: string) => unknown; header: (k: string, v: string) => unknown; send: (b: string) => unknown },
  body: string) {
  reply.type("text/html; charset=utf-8");
  reply.header("cache-control", "no-store");
  return reply.send(body);
}

function page(title: string, body: string, width: "narrow" | "wide" = "narrow"): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--forest-800:#1D4735;--forest-700:#285B46;--ink-900:#142018;--ink-500:#5F6C64;
--border:#E4E9E3;--fill:#EAF0ED;--gold:#CC9E50;--cream:#F7F8F4;--white:#fff}
body{margin:0;background:var(--cream);color:var(--ink-900);
font:15px/1.6 'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
display:flex;min-height:100vh;align-items:flex-start;justify-content:center;padding:40px 20px}
main{max-width:${width === "wide" ? "720px" : "520px"};width:100%;background:var(--white);
border:1px solid var(--border);border-radius:20px;padding:40px;
box-shadow:0 20px 50px rgba(20,32,24,.14)}
.eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;
color:var(--gold);margin:0 0 12px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}
.version{color:var(--ink-500);margin:0 0 20px}
p{color:var(--ink-500)}
.muted{font-size:13px}
.notice{background:var(--fill);border-radius:12px;padding:14px 16px;font-size:13px}
a{color:var(--forest-700)}
a.primary{display:inline-block;margin:12px 0;padding:12px 20px;background:var(--forest-800);
color:#fff;border-radius:12px;text-decoration:none;font-weight:600}
a.primary:hover{background:#143D2F}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
word-break:break-all}
ul.rows{list-style:none;margin:20px 0;padding:0;border:1px solid var(--border);
border-radius:12px;overflow:hidden}
ul.rows li{display:flex;flex-direction:column;gap:2px;padding:14px 16px;
border-bottom:1px solid var(--border)}
ul.rows li:last-child{border-bottom:none}
.row-title{font-weight:600;color:var(--ink-900)}
.doc{margin-top:28px;border-top:1px solid var(--border);padding-top:24px;color:var(--ink-900)}
.doc h2{font-size:20px;margin:28px 0 8px}
.doc h3{font-size:17px;margin:24px 0 6px}
.doc h4,.doc h5{font-size:15px;margin:20px 0 6px}
.doc p,.doc li{color:var(--ink-900)}
.doc li{margin:4px 0}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
