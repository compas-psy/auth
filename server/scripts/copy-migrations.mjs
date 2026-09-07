// Переносит SQL-миграции в собранный код.
//
// Сервис ищет их рядом с собой (src/db/migrate.ts: join(dirname(
// import.meta.url), "migrations")). В разработке это src/db/migrations
// и всё сходится, а tsc переносит только .ts — в dist миграций не
// оказывается, и контейнер падает при СТАРТЕ:
//   ENOENT: no such file or directory, scandir '/app/dist/db/migrations'
// Сборка образа при этом успешна: она приложение не запускает.
//
// Поведение проверяется тестом server/test/build.artifacts.test.ts.

import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(server, "src/db/migrations");
// Куда класть, можно задать первым доводом: этим пользуется тест,
// чтобы не писать в рабочий dist.
const to = join(process.argv[2] ?? join(server, "dist"), "db/migrations");

const files = (await readdir(from)).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error("ОШИБКА: в src/db/migrations нет ни одного .sql — копировать нечего.");
  process.exit(1);
}

await mkdir(to, { recursive: true });
for (const file of files) {
  await cp(join(from, file), join(to, file));
}
console.log(`Миграций перенесено: ${files.length}`);
