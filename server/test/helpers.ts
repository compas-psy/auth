import { getPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

let migrated = false;

/** Прогоняет миграции один раз на весь прогон тестов. */
export async function ensureSchema(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
}

/**
 * Чистит данные между тестами. accounts CASCADE уносит всё, что на неё
 * ссылается; таблицы без ссылки на аккаунт чистятся отдельно.
 */
export async function resetData(): Promise<void> {
  await ensureSchema();
  const { rows } = await getPool().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (!rows.length) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await getPool().query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}
