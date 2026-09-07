import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseChangelog, type ChangelogEntry } from "./changelog.js";

/** Адрес страницы ручки. Один путь — одна страница. */
export function slug(path: string): string {
  return path
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "root";
}

const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (s: string): string => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);

interface Spec {
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, Operation>>;
  security?: Array<Record<string, unknown>>;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>;
  };
}

interface Operation {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, unknown>>;
  description?: string;
  tags?: string[];
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: SchemaObject }> }>;
}

interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  enum?: unknown[];
  "x-extensible-enum"?: unknown[];
  required?: string[];
  examples?: unknown[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface BuildOptions {
  specPath: string;
  outDir: string;
  changelogPath?: string;
}

/**
 * Справочник ГЕНЕРИРУЕТСЯ из спецификации, а не пишется руками —
 * иначе он разойдётся с реализацией в первый же месяц.
 */
export async function buildSite(opts: BuildOptions): Promise<void> {
  const spec = parse(readFileSync(opts.specPath, "utf8")) as Spec;
  const server = spec.servers[0]?.url ?? "https://auth.cmpas.ru/v1";
  const changelog = parseChangelog(opts.changelogPath ?? "../docs/CHANGELOG-api.md");

  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(join(opts.outDir, "reference"), { recursive: true });

  // Спецификация выкладывается рядом: она и есть источник истины,
  // а справочник — её прочтение.
  writeFileSync(join(opts.outDir, "simpasid.v1.yaml"), readFileSync(opts.specPath));

  const pages = Object.entries(spec.paths).map(([path, ops]) => ({ path, ops }));

  writeFileSync(join(opts.outDir, "index.html"), indexPage(spec, server, pages));
  writeFileSync(join(opts.outDir, "changelog.html"), changelogPage(spec, changelog));

  for (const { path, ops } of pages) {
    writeFileSync(
      join(opts.outDir, "reference", `${slug(path)}.html`),
      referencePage(spec, server, path, ops, pages),
    );
  }
}

function layout(title: string, nav: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--forest-800:#1D4735;--forest-700:#285B46;--ink-900:#142018;--ink-500:#5F6C64;
--ink-400:#8A9089;--border:#E4E9E3;--fill:#EAF0ED;--gold:#CC9E50;--cream:#F7F8F4;--white:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink-900);
font:15px/1.6 'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
header{background:var(--forest-800);color:#fff;padding:16px 24px;display:flex;
align-items:center;gap:24px;flex-wrap:wrap}
header .brand{font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:13px}
header a{color:#fff;text-decoration:none;opacity:.85;font-size:14px}
header a:hover{opacity:1;text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:32px 24px 64px;display:grid;
grid-template-columns:240px 1fr;gap:32px}
.wrap.single{grid-template-columns:1fr}
nav.side{font-size:14px}
nav.side a{display:block;padding:6px 0;color:var(--forest-700);text-decoration:none}
nav.side a:hover{text-decoration:underline}
nav.side .group{margin:16px 0 4px;font-weight:700;font-size:12px;text-transform:uppercase;
letter-spacing:.06em;color:var(--gold)}
h1{font-size:32px;line-height:1.15;margin:0 0 12px}
h2{font-size:18px;margin:32px 0 8px}
h3{font-size:15px;margin:20px 0 6px}
p{color:var(--ink-500)}
p.lede{font-size:17px;color:var(--ink-900)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--white);border:1px solid var(--border);border-radius:12px;
padding:16px;overflow:auto;font-size:13px;color:var(--ink-900)}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--white);
border:1px solid var(--border);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
th{background:var(--fill);font-size:12px;text-transform:uppercase;letter-spacing:.06em;
color:var(--ink-500)}
tr:last-child td{border-bottom:0}
.method{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--forest-700);
color:#fff;font-size:12px;font-weight:700;letter-spacing:.04em}
.path{font-family:ui-monospace,monospace;font-size:15px}
.note{background:var(--fill);border-left:3px solid var(--forest-700);padding:14px 16px;
border-radius:0 12px 12px 0;margin:20px 0}
.note strong{color:var(--ink-900)}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:700}
.badge.breaking{background:#F6E4E1;color:#B24B3F}
.badge.non-breaking{background:#E7F1E9;color:#2F7A4F}
.card{background:var(--white);border:1px solid var(--border);border-radius:16px;padding:20px;
margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
@media(max-width:860px){.wrap{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <span class="brand">СИМПАС · для разработчиков</span>
  <a href="/dev/">Начать</a>
  <a href="/dev/reference/account.html">Справочник</a>
  <a href="/dev/simpasid.v1.yaml">Спецификация</a>
  <a href="/dev/changelog.html">Изменения</a>
</header>
${nav}
${body}
</body>
</html>`;
}

function sideNav(
  spec: Spec,
  pages: Array<{ path: string; ops: Record<string, Operation> }>,
  active?: string,
): string {
  const byTag = new Map<string, Array<{ path: string; label: string }>>();
  for (const { path, ops } of pages) {
    const op = METHODS.map((m) => ops[m]).find(Boolean);
    const tag = op?.tags?.[0] ?? "прочее";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push({ path, label: path });
  }
  const tagTitle = new Map((spec.tags ?? []).map((t) => [t.name, t.description ?? t.name]));
  let out = '<nav class="side">';
  for (const [tag, items] of byTag) {
    out += `<div class="group">${esc(tagTitle.get(tag) ?? tag)}</div>`;
    for (const i of items) {
      const current = i.path === active ? ' style="font-weight:700"' : "";
      out += `<a href="/dev/reference/${slug(i.path)}.html"${current}>${esc(i.label)}</a>`;
    }
  }
  return out + "</nav>";
}

/** Артборд R1 — титульная. Отвечает на один вопрос: как сделать первый вызов. */
function indexPage(
  spec: Spec, server: string,
  pages: Array<{ path: string; ops: Record<string, Operation> }>,
): string {
  const example = `curl ${server}/account \\
  -H "Authorization: Bearer <ваш ключ>"`;
  const response = JSON.stringify({
    id: "acc_8f21…",
    email: "t…v@ya.ru",
    email_verified: true,
    products: ["practice", "zapiski"],
  }, null, 2);

  return layout(spec.info.title, "", `<div class="wrap single">
<h1>${esc(spec.info.title)}</h1>
<p class="lede">Профиль и почты, способы входа, устройства и сеансы, согласия и коммуникации,
журнал событий. Портал аккаунта работает этим же API — расхождений между продуктами
не возникает.</p>

<h2>Первый запрос</h2>
<pre>${esc(example)}</pre>
<h3>Ответ</h3>
<pre>${esc(response)}</pre>
<p>Ключ выдаётся в кабинете сервиса. От регистрации до первого успешного ответа —
не больше пяти минут: это тот показатель, по которому ресурс и оценивается.</p>

<div class="note">
<strong>Правило, снимающее самодеятельность.</strong>
Если чего-то нет в спецификации — этого не может быть и на экране. Отдельного внутреннего
API для наших собственных интерфейсов не существует.
</div>

<h2>Что дальше</h2>
<div class="grid">
<div class="card"><h3>Спецификация</h3><p>OpenAPI — единственный источник истины.
Справочник собирается из неё, а не пишется руками.</p>
<a href="/dev/simpasid.v1.yaml">Открыть</a></div>
<div class="card"><h3>Справочник</h3><p>${pages.length} ручек в шести группах.</p>
<a href="/dev/reference/account.html">Открыть</a></div>
<div class="card"><h3>Изменения</h3><p>Версионирование, сроки миграции и уведомление
о прекращении поддержки.</p><a href="/dev/changelog.html">Открыть</a></div>
</div>

<h2>Границы, заданные схемой</h2>
<p>Полей телефона, одноразового кода и пароля в API нет и не появится: они запрещены
инвариантом на уровне схемы и защищены тестом.</p>
</div>`);
}

/** Артборд R2 — страница справочника. */
function referencePage(
  spec: Spec, server: string, path: string,
  ops: Record<string, Operation>,
  pages: Array<{ path: string; ops: Record<string, Operation> }>,
): string {
  let body = `<div>`;
  for (const method of METHODS) {
    const op = ops[method];
    if (!op) continue;
    body += `<h1><span class="method">${method.toUpperCase()}</span>
<span class="path">${esc(path)}</span></h1>`;
    if (op.summary) body += `<p class="lede">${esc(op.summary)}</p>`;
    if (op.description) body += `<p>${esc(op.description)}</p>`;

    const schema = responseSchema(spec, op);
    if (schema) {
      body += `<h2>Поля ответа</h2>${fieldsTable(spec, schema)}`;
    }

    body += `<h2>Запрос</h2><pre>${esc(curlFor(spec, server, method, path, op))}</pre>`;
    const example = exampleFor(spec, schema);
    if (example) body += `<h2>Ответ · 200</h2><pre>${esc(example)}</pre>`;
  }
  body += `<div class="note"><strong>Границы, заданные схемой.</strong>
Полей телефона, одноразового кода и пароля в API нет и не появится: они запрещены
инвариантом на уровне схемы и защищены тестом.</div></div>`;

  return layout(`${path} · ${spec.info.title}`, sideNav(spec, pages, path),
    `<div class="wrap">${body}</div>`);
}

/**
 * Заголовки примера берутся из security операции, а не из привычки.
 *
 * У ручек аккаунта это ключ доступа; у первичного токен-API — имя
 * приложения (X-Client-Id), и ключа доступа там нет вовсе: его ещё не
 * выдали, вход только начинается. Пример, зовущий не тот заголовок,
 * даёт разработчику 403 на ручке, которую справочник только что
 * описал как рабочую.
 */
function curlFor(
  spec: Spec, server: string, method: string, path: string, op: Operation,
): string {
  const url = `${server}${path.replace(/\{([^}]+)\}/g, "<$1>")}`;
  const verb = method === "get" ? "" : ` -X ${method.toUpperCase()}`;
  const schemes = spec.components.securitySchemes ?? {};
  const names = (op.security ?? spec.security ?? []).flatMap((s) => Object.keys(s));
  const headers = names.map((name) => {
    const scheme = schemes[name];
    if (scheme?.type === "apiKey" && scheme.in === "header") {
      return `  -H "${scheme.name}: <идентификатор приложения>"`;
    }
    return `  -H "Authorization: Bearer <ваш ключ>"`;
  });
  if (headers.length === 0) return `curl${verb} ${url}`;
  return `curl${verb} ${url} \\\n${headers.join(" \\\n")}`;
}

function deref(spec: Spec, schema: SchemaObject | undefined): SchemaObject | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return spec.components.schemas[name];
  }
  return schema;
}

function responseSchema(spec: Spec, op: Operation): SchemaObject | undefined {
  const ok = op.responses?.["200"] ?? op.responses?.["202"];
  return deref(spec, ok?.content?.["application/json"]?.schema);
}

function fieldsTable(spec: Spec, schema: SchemaObject): string {
  const rows: string[] = [];
  const walk = (s: SchemaObject | undefined, prefix: string, depth: number): void => {
    const resolved = deref(spec, s);
    if (!resolved?.properties || depth > 2) return;
    for (const [name, raw] of Object.entries(resolved.properties)) {
      const prop = deref(spec, raw) ?? raw;
      rows.push(`<tr><td><code>${esc(prefix + name)}</code></td>
<td>${esc(typeName(spec, prop))}</td><td>${esc(prop.description ?? raw.description ?? "")}</td></tr>`);
      if (prop.type === "array" && prop.items) walk(prop.items, `${prefix}${name}[].`, depth + 1);
      else if (prop.properties) walk(prop, `${prefix}${name}.`, depth + 1);
    }
  };
  walk(schema, "", 0);
  if (!rows.length) return "";
  return `<table><thead><tr><th>Поле</th><th>Тип</th><th>Что это</th></tr></thead>
<tbody>${rows.join("")}</tbody></table>`;
}

/**
 * Элемент массива разыменовывается. Без этого `products` печатался как
 * array<object>: разработчик не видел ни одного продукта, а взять их
 * больше неоткуда — справочник генерируется из спецификации.
 */
function typeName(spec: Spec, raw: SchemaObject): string {
  const s = deref(spec, raw) ?? raw;
  if (s.enum) return s.enum.join(" | ");
  // Растущий набор печатается с многоточием: значения назвать надо —
  // больше их взять неоткуда, — но выдавать открытый набор за полный
  // значит обещать, что нового продукта не появится.
  const open = s["x-extensible-enum"];
  if (open?.length) return `${open.join(" | ")} | …`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") return `array<${s.items ? typeName(spec, s.items) : "object"}>`;
  return s.type ?? "object";
}

function exampleFor(spec: Spec, schema: SchemaObject | undefined): string | null {
  const value = sample(spec, schema, 0);
  return value === undefined ? null : JSON.stringify(value, null, 2);
}

function sample(spec: Spec, raw: SchemaObject | undefined, depth: number): unknown {
  const s = deref(spec, raw);
  if (!s || depth > 4) return undefined;
  if (s.examples?.length) return s.examples[0];
  if (s.enum?.length) return s.enum[0];
  if (s["x-extensible-enum"]?.length) return s["x-extensible-enum"][0];
  if (s.type === "array") return [sample(spec, s.items, depth + 1)].filter((v) => v !== undefined);
  if (s.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      const value = sample(spec, v, depth + 1);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  if (Array.isArray(s.type)) return null;
  if (s.type === "string") return "…";
  if (s.type === "integer" || s.type === "number") return 0;
  if (s.type === "boolean") return true;
  return undefined;
}

/** Артборд R3 — журнал изменений. */
function changelogPage(spec: Spec, entries: ChangelogEntry[]): string {
  const items = entries.map((e) => `<div class="card">
<span class="badge ${e.badge}">${e.badge === "breaking" ? "ломающее" : "не ломающее"}</span>
<strong style="margin-left:8px">${esc(e.version)}</strong>
<span style="color:var(--ink-400);margin-left:8px">${esc(e.date)}</span>
<p>${esc(e.title)}</p>
${e.sunset ? `<p><strong>Прежнее поведение работает до ${esc(e.sunset)}.</strong></p>` : ""}
</div>`).join("");

  return layout(`Журнал изменений · ${spec.info.title}`, "", `<div class="wrap single">
<h1>Журнал изменений</h1>
<p class="lede">Каждая запись говорит, ломает ли изменение существующих потребителей,
и до какого числа работает прежнее поведение.</p>
<p>Ломающее изменение видно до слияния, а не после: спецификация проверяется в сборке,
и расхождение с прежней редакцией останавливает её.</p>
${items}
</div>`);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  await buildSite({ specPath: "../server/openapi/simpasid.v1.yaml", outDir: "dist" });
  process.stdout.write("devsite built\n");
}
