/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Реестр формулировок — ОДИН на всю экосистему (05_CONSENT_PDN.md
      // §7.5). Сервер отдаёт юридическую строку прямо в разметке, портал
      // рисует те же тексты; две копии означали бы два разных экрана
      // входа, и одна из них рано или поздно разошлась бы с макетом.
      "@wording": fileURLToPath(new URL("../server/src/ui/wording.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Имена без хеша: сервер отдаёт оболочку сам и ссылается на них
    // из src/ui/render.ts. Хеш в имени означал бы, что оболочку надо
    // пересобирать вместе с портом каждый раз.
    rollupOptions: {
      output: {
        entryFileNames: "assets/portal.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (info) =>
          info.names?.[0]?.endsWith(".css") ? "assets/portal.css" : "assets/[name][extname]",
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.spec.tsx", "test/**/*.spec.ts"],
  },
});
