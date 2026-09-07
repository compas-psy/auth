import { getPool } from "../db/pool.js";

/**
 * Состояние схемы боевой базы — для осмотра сервера.
 *
 * Отвечает на два вопроса, на которые раньше приходилось отвечать
 * рассуждением: какие миграции применены и стоит ли запрет на смену
 * `sub`. Рассуждение было верным (`listen` происходит только после
 * `runMigrations`, значит отвечающий сервис миграции применил), но
 * обязательство перед продуктом лучше видеть, чем выводить.
 *
 * Только чтение. Ни строчки пользовательских данных: имена миграций и
 * наличие триггера — не сведения о людях.
 */
export interface SchemaReport {
  migrations: string[];
  /** Стоит ли запрет на смену идентификатора учётной записи. */
  subImmutable: boolean;
}

export async function schemaReport(): Promise<SchemaReport> {
  const pool = getPool();

  const migrations = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name");

  // Наличие триггера спрашивается у самой базы, а не выводится из того,
  // что миграция числится применённой: миграцию могли откатить руками.
  const guard = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'accounts'
        AND t.tgname = 'accounts_id_immutable'
        AND NOT t.tgisinternal
    ) AS present`);

  return {
    migrations: migrations.rows.map((r) => r.name),
    subImmutable: guard.rows[0]?.present === true,
  };
}
