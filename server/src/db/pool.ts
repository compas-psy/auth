import pg from "pg";
import { loadConfig } from "../config.js";

// Даты возвращаются строками там, где нам нужен ISO 8601 без пересчёта
// в местное время процесса: timestamptz читается как есть.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: loadConfig().databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Без этого обработчика единичная сетевая ошибка простаивающего
    // соединения роняет процесс: pg поднимает 'error' на самом пуле.
    pool.on("error", () => {});
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/** Транзакция с гарантированным откатом: половина записи хуже отказа. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* соединение уже мертво — исходная ошибка важнее */
    }
    throw e;
  } finally {
    client.release();
  }
}
