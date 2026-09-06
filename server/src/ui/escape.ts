const MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Экранирование для HTML. Своего парсера нет — только подстановка. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => MAP[c] ?? c);
}
