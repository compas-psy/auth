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
import { registerPortal, registerDevsite } from "./ui/static.js";
import { registerLegalRoutes } from "./api/legal.js";
import { connectConfiguredProviders } from "./services/providers/registry.js";
import { renderScreen } from "./ui/render.js";

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

  /**
   * Общий обработчик отказов.
   *
   * Наружу не уходит ни причина, ни путь, ни стек: сообщение ошибки
   * содержит адреса и имена — «ECONNREFUSED at /var/lib/postgresql»
   * это рассказ о внутреннем устройстве тому, кто спрашивал про вход.
   *
   * Т8: человек, пришедший входить, когда сервис нездоров, видит
   * человеческий текст экрана C4, а не техническую ошибку.
   */
  app.setErrorHandler(async (error: unknown, req, reply) => {
    const raw = (error as { statusCode?: unknown }).statusCode;
    const status = typeof raw === "number" && raw >= 400 ? raw : 500;
    if (status >= 500) {
      logger.error({ event: "request_failed", outcome: "fail", status });
    }
    const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
    if (wantsHtml) {
      return reply
        .code(status)
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(renderScreen("Unavailable", {}));
    }
    return reply.code(status).send({ error: status >= 500 ? "unavailable" : "bad_request" });
  });

  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(404).send({ error: "not_found" }));

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
  // Подключаем то, для чего переданы ключи. Провайдер без ключей не
  // появляется ни на экране, ни на маршруте возврата.
  await connectConfiguredProviders(config.issuer);

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
    app.get(wellKnown, async (req, reply) => {
      // Заголовки, определяющие происхождение, переносятся в
      // переспрос. Провайдер строит АБСОЛЮТНЫЕ адреса ручек из
      // запроса, а не из настроенного issuer (документация
      // oidc-provider, FAQ «Why does my .well-known/openid-configuration
      // link to http endpoints»). Синтетический запрос inject идёт без
      // Host, и без переноса все адреса выходили
      // http://localhost/oidc/... при верном issuer — доверяющая
      // сторона пошла бы за ключами по http на localhost.
      //
      // Переносится ровно то, что влияет на построение адреса. Cookie,
      // Authorization и прочее во внутренний запрос не уезжают: им там
      // нечего делать.
      const forwarded: Record<string, string> = {};
      for (const name of ["host", "x-forwarded-proto", "x-forwarded-host"]) {
        const value = req.headers[name];
        if (typeof value === "string") forwarded[name] = value;
      }
      const inner = await app.inject({
        url: `${OIDC_MOUNT}/.well-known/openid-configuration`,
        headers: forwarded,
      });
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
  await registerDevsite(app);
  await registerLegalRoutes(app);
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
