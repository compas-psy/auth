import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./lib/logging.js";

export interface BuildOptions {
  /** Прогонять ли миграции при сборке. В тестах — один раз, в проде — всегда. */
  migrate?: boolean;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig();
  if (opts.migrate) await runMigrations();

  const app = Fastify({
    // Свой логгер: штатный pino печатает URL и заголовки, а в них
    // едут почта и токены. Требование У-9 — журналов без ПДн.
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return reply.send({ status: "ok", issuer: config.issuer });
    } catch {
      // Причина наружу не уходит: строка подключения — это адрес и имя базы.
      logger.error({ event: "healthz", outcome: "fail" });
      return reply.code(503).send({ status: "degraded" });
    }
  });

  return app;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  const config = loadConfig();
  buildServer({ migrate: true })
    .then((app) => app.listen({ port: config.port, host: config.host }))
    .then(() => logger.info({ event: "listen", port: config.port }))
    .catch((e) => {
      logger.error({ event: "boot", outcome: "fail", reason: String(e) });
      process.exit(1);
    });
}
