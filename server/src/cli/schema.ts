/**
 * Состояние схемы боевой базы — для осмотра сервера.
 *
 * Только спрашивает. Ни одной команды, меняющей состояние: осмотр
 * ходит на боевой сервер, где рядом живёт продукт соседа, и цена
 * ошибки здесь не «неверный вывод», а упавшая ПРАКТИКА.
 *
 * Запуск внутри контейнера — там уже есть DATABASE_URL:
 *   docker exec simpasid-app node dist/cli/schema.js
 */
import { schemaReport } from "../services/schemaReport.js";
import { closePool } from "../db/pool.js";

async function main(): Promise<number> {
  const report = await schemaReport();

  // Пустой вывод — не ответ: его принимают за «всё в порядке».
  if (report.migrations.length === 0) {
    console.log("МИГРАЦИЙ НЕ ПРИМЕНЕНО НИ ОДНОЙ — база пуста");
  } else {
    console.log(`применено миграций: ${report.migrations.length}`);
    for (const name of report.migrations) console.log(`  ${name}`);
  }

  console.log("");
  console.log(report.subImmutable
    ? "запрет на смену sub: СТОИТ"
    // Обязательство перед ПРАКТИКОЙ: их связь с человеком держится на
    // нашем sub. Молчание здесь было бы хуже отсутствия проверки.
    : "запрет на смену sub: НЕ СТОИТ — обязательство перед ПРАКТИКОЙ не обеспечено");

  return 0;
}

main()
  .then(async (code) => { await closePool(); process.exit(code); })
  .catch(async (e: unknown) => {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    await closePool();
    process.exit(1);
  });
