import { getPool } from "../db/pool.js";

/**
 * Свод событий за последние часы — для разбора «вход не работает».
 *
 * У каждой ветки отказа во входе через внешний сервис своё событие:
 * `provider_state`, `provider_exchange`, `provider_login`. По тому,
 * какое записано последним, видно, ДОКУДА дошёл человек, — а это и
 * есть ответ на вопрос, что чинить.
 *
 * Отдаётся СВОД, а не строки. Строка журнала привязана к учётной
 * записи, а разбирающему нужна картина, а не чей-то конкретный вход:
 * ни идентификаторов, ни хешей адреса здесь нет и быть не должно.
 */
export interface EventCount {
  event: string;
  provider: string | null;
  outcome: "ok" | "fail";
  count: number;
}

export async function recentEvents(hours: number): Promise<EventCount[]> {
  const window = Math.min(Math.max(hours, 1), 168);
  const { rows } = await getPool().query<{
    event: string; provider: string | null; outcome: "ok" | "fail"; count: string;
  }>(
    `SELECT event, provider, outcome, count(*)::text AS count
     FROM audit_log
     WHERE at > now() - make_interval(hours => $1)
     GROUP BY event, provider, outcome
     ORDER BY count(*) DESC, event`,
    [window],
  );
  return rows.map((r) => ({
    event: r.event,
    provider: r.provider,
    outcome: r.outcome,
    count: Number(r.count),
  }));
}
