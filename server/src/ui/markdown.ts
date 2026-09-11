import { escapeHtml } from "./escape.js";

/**
 * Крошечный подмножественный разметчик для юридических текстов.
 *
 * Библиотеки здесь нет намеренно: единственный источник этих текстов —
 * юридический пакет, положенный в репозиторий человеком, и набор
 * нужной ему разметки исчерпывается заголовками, абзацами, списками,
 * выделением и ссылками на соседние документы. Полноценный разметчик
 * принёс бы сюда HTML, встраивание и правила, которых мы не хотим.
 *
 * Порядок важен: СНАЧАЛА экранируется всё, потом накладывается
 * разрешённое. Обратный порядок — обычный способ завести XSS.
 */
export function renderLegalMarkdown(source: string): string {
  const blocks: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    blocks.push(`<${list.kind}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.kind}>`);
    list = null;
  };

  for (const raw of source.split(/\r?\n\r?\n/)) {
    const chunk = raw.trim();
    if (!chunk) continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(chunk);
    if (heading && !chunk.includes("\n")) {
      flush();
      const level = Math.min(heading[1]!.length + 1, 5);
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    const lines = chunk.split(/\r?\n/);
    const bullets = lines.every((l) => /^[-*]\s+/.test(l.trim()));
    const numbers = lines.every((l) => /^\d+[.)]\s+/.test(l.trim()));
    if (bullets || numbers) {
      flush();
      list = {
        kind: bullets ? "ul" : "ol",
        items: lines.map((l) => inline(l.trim().replace(/^([-*]|\d+[.)])\s+/, ""))),
      };
      flush();
      continue;
    }

    flush();
    // Перенос строки внутри абзаца сохраняется: в юридических текстах
    // это часто разбивка перечисления, и склеивать её нельзя.
    blocks.push(`<p>${lines.map((l) => inline(l.trim())).join("<br>")}</p>`);
  }
  flush();
  return blocks.join("\n");
}

function inline(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Ссылки — ТОЛЬКО внутренние. Юридический документ ссылается на
  // соседний документ Экосистемы, а не наружу; внешний адрес в тексте
  // остаётся текстом, и это видно.
  html = html.replace(/\[([^\]]+)\]\((\/[A-Za-z0-9/_\-.]*)\)/g,
    (_m, label: string, href: string) => `<a href="${href}">${label}</a>`);
  return html;
}
