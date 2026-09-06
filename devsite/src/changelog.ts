import { readFileSync } from "node:fs";

export interface ChangelogEntry {
  version: string;
  date: string;
  badge: "breaking" | "non-breaking";
  title: string;
  body: string;
  /** Для ломающего изменения — до какого числа работает прежнее поведение. */
  sunset: string | null;
}

/**
 * Журнал изменений API.
 *
 * Каждая запись обязана говорить, ломает ли изменение существующих
 * потребителей, и до какого числа работает прежнее поведение
 * (артборд R3). Запись без пометки — это изменение, о котором
 * потребитель узнает падением.
 */
export function parseChangelog(path: string): ChangelogEntry[] {
  const text = readFileSync(path, "utf8");
  const entries: ChangelogEntry[] = [];

  // ## 1.0.0 — 2026-09-06 — non-breaking
  const blocks = text.split(/^## /m).slice(1);
  for (const block of blocks) {
    const [heading = "", ...rest] = block.split("\n");
    const m = /^(\S+)\s+—\s+(\S+)\s+—\s+(breaking|non-breaking)\s*$/.exec(heading.trim());
    if (!m) continue;
    const body = rest.join("\n").trim();
    const sunset = /Прежнее поведение работает до\s+(\S+)/.exec(body)?.[1] ?? null;
    const title = rest.find((l) => l.trim().length > 0)?.trim() ?? "";
    entries.push({
      version: m[1]!,
      date: m[2]!,
      badge: m[3] as "breaking" | "non-breaking",
      title,
      body,
      sunset,
    });
  }
  return entries;
}
