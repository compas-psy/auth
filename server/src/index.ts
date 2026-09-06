import Fastify, { type FastifyInstance } from "fastify";
import middie from "@fastify/middie";
import { loadConfig } from "./config.js";
import { getPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./lib/logging.js";
import { buildProvider, OIDC_MOUNT } from "./oidc/provider.js";
import { registerAuthRoutes } from "./api/v1/auth.js";
import { registerAccountRoutes } from "./api/v1/account.js";
import { registerIdentityRoutes } from "./api/v1/identities.js";
import { registerSessionRoutes } from "./api/v1/sessions.js";
import { registerConsentRoutes } from "./api/v1/consents.js";
import { registerAuditRoutes } from "./api/v1/audit.js";
import { registerInteractionRoutes } from "./oidc/interactions.js";
import { registerPortal } from "./ui/static.js";

export interface BuildOptions {
  /** Прогонять ли миграции при сборке. В тестах — один раз, в проде — всегда. */
  migrate?: boolean;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig();
  if (opts.migrate) await runMigrations();

  const app = Fastify({
    // Свой логгер: штатный печатает URL и заголовки, а в них едут
    // почта и токены. Требование У-9 — журналов без ПДн.
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

  // Монтирование по ответу context7 (docs/README.md, «Mount oidc-provider
  // to Fastify»): @fastify/middie + fastify.use(prefix, provider.callback()).
  // Провайдер сам выводит префикс из req.originalUrl
  // (lib/helpers/oidc_context.js:88), поэтому объявленные в discovery
  // адреса ручек получаются с /oidc.
  const provider = await buildProvider();
  await app.register(middie);
  app.use(OIDC_MOUNT, provider.callback());

  // Тот же ответ context7 требует развесить метаданные так, чтобы они
  // находились по адресу, который выводится из issuer. Клиент с
  // issuer = https://auth.cmpas.ru идёт на /.well-known/openid-configuration,
  // а провайдер смонтирован на /oidc — без этой пары рецепт для ПРАКТИКИ
  // не работает. Источник истины один: ответ отдаёт сам провайдер.
  for (const wellKnown of [
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ]) {
    app.get(wellKnown, async (_req, reply) => {
      const inner = await app.inject({ url: `${OIDC_MOUNT}/.well-known/openid-configuration` });
      return reply.code(inner.statusCode).type("application/json").send(inner.body);
    });
  }

  app.decorate("oidc", provider);
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerIdentityRoutes(app);
  await registerSessionRoutes(app);
  await registerConsentRoutes(app);
  await registerAuditRoutes(app);
  await registerInteractionRoutes(app, provider);
  await registerPortal(app);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    oidc: Awaited<ReturnType<typeof buildProvider>>;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

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
