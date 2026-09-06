import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Один процесс: тесты делят одну базу и чистят её через TRUNCATE.
    // Параллельные файлы затирали бы друг другу данные.
    pool: "forks",
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    setupFiles: ["test/setup.ts"],
  },
});
