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
  build: { outDir: "dist", sourcemap: true },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.spec.tsx", "test/**/*.spec.ts"],
  },
});
