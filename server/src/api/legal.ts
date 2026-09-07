import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { escapeHtml } from "../ui/escape.js";

interface DocumentVersion {
  code: string;
  title: string;
  version: string;
  effective_at: Date;
  content_hash: string;
  immutable_url: string;
  text_url: string | null;
}

/**
 * Неизменяемые адреса редакций документов.
 *
 * Требование юрпакета §11 и задания 08 §2.4: ссылка ведёт на
 * КОНКРЕТНУЮ редакцию, а не на текущую. Человек, принявший
 * соглашение в редакции 0.9, обязан иметь возможность посмотреть
 * именно её — даже когда действует уже 1.0.
 *
 * Адрес не собирается из частей пути, а ищется в реестре целиком:
 * подстановка кода и версии в шаблон открыла бы дорогу обходу
 * каталогов и выдаче чужого документа под нужным адресом.
 */
export async function registerLegalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { "*": string } }>("/legal/*", async (req, reply) => {
    const path = `/legal/${req.params["*"]}`;
    const { rows } = await getPool().query<DocumentVersion>(
      `SELECT v.code, d.title, v.version, v.effective_at, v.content_hash,
              v.immutable_url, v.text_url
       FROM legal_document_versions v
       JOIN legal_documents d ON d.code = v.code
       WHERE v.immutable_url = $1`,
      [path],
    );
    const doc = rows[0];
    if (!doc) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(notFoundPage());
    }
    return reply
      .type("text/html; charset=utf-8")
      // Редакция неизменяема по определению: её можно кэшировать надолго.
      .header("cache-control", "public, max-age=86400, immutable")
      .send(documentPage(doc));
  });
}

function documentPage(doc: DocumentVersion): string {
  const effective = doc.effective_at.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
  // content_hash = PENDING означает, что текст ещё не опубликован в
  // сервис. Молчать об этом нельзя: доказательством согласия служит
  // связка «редакция + хеш того, что человек видел».
  const hashKnown = doc.content_hash !== "PENDING";

  const textBlock = doc.text_url
    ? `<p><a class="primary" href="${escapeHtml(doc.text_url)}">Читать текст документа</a></p>`
    : `<p class="muted">Текст этой редакции ещё не опубликован.</p>`;

  const hashBlock = hashKnown
    ? `<p class="muted">Отпечаток текста: <code>${escapeHtml(doc.content_hash.slice(0, 16))}…</code></p>`
    : `<p class="notice">Отпечаток текста этой редакции ещё не подтверждён.
       Пока это так, ссылка ведёт на действующую публикацию документа,
       а не на снимок именно этой редакции.</p>`;

  return page(`${doc.title}, редакция ${doc.version}`, `
<p class="eyebrow">Документ СИМПАС</p>
<h1>${escapeHtml(doc.title)}</h1>
<p class="version">редакция ${escapeHtml(doc.version)}</p>
<p class="muted">Действует с ${escapeHtml(effective)}.</p>
${textBlock}
${hashBlock}
<p class="muted">Это постоянный адрес именно этой редакции. Он не меняется,
даже когда выходит новая.</p>`);
}

function notFoundPage(): string {
  return page("Документ не найден", `
<h1>Документ не найден</h1>
<p class="muted">Такой редакции у нас нет. Возможно, ссылка набрана с опечаткой.</p>
<p><a class="primary" href="https://cmpas.ru/legal/terms">Все документы</a></p>`);
}

function page(title: string, body: string): string {
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
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:40px 20px}
main{max-width:520px;width:100%;background:var(--white);border:1px solid var(--border);
border-radius:20px;padding:40px;box-shadow:0 20px 50px rgba(20,32,24,.14)}
.eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;
color:var(--gold);margin:0 0 12px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}
.version{color:var(--ink-500);margin:0 0 20px}
p{color:var(--ink-500)}
.muted{font-size:13px}
.notice{background:var(--fill);border-radius:12px;padding:14px 16px;font-size:13px}
a.primary{display:inline-block;margin:12px 0;padding:12px 20px;background:var(--forest-800);
color:#fff;border-radius:12px;text-decoration:none;font-weight:600}
a.primary:hover{background:#143D2F}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
