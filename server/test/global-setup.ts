import pg from "pg";

/**
 * Один раз на прогон: пересоздаёт схему начисто. Тесты идут против
 * настоящего Postgres, и остатки прошлого прогона (усечённые справочники,
 * применённые миграции) делали бы результат зависящим от истории машины.
 */
export default async function setup(): Promise<void> {
  process.env.DATABASE_URL ??= "postgres://simpasid:simpasid@127.0.0.1:5433/simpasid_test";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await client.end();
}
