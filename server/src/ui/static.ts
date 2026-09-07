import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { renderScreen } from "./render.js";
import { currentDocument } from "../services/consents.js";
import type { Product } from "../services/accounts.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Портал собирается в portal/dist и отдаётся отсюда. */
function portalDist(): string | null {
  const candidates = [
    process.env.PORTAL_DIST,
    resolve(HERE, "../../../portal/dist"),
    resolve(HERE, "../../portal/dist"),
    "/app/portal",
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, "assets/portal.js"))) ?? null;
}

/**
 * Ресурс разработчика собирается в devsite/dist из спецификации.
 * Пути перечислены теми же кандидатами, что и у портала: в образе
 * это /app/devsite, в разработке — каталог сборки рядом.
 */
function devsiteDist(): string | null {
  const candidates = [
    process.env.DEVSITE_DIST,
    resolve(HERE, "../../../devsite/dist"),
    resolve(HERE, "../../devsite/dist"),
    "/app/devsite",
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? null;
}

/**
 * Справочник разработчика на …/dev. CLAUDE.md называет его частью
 * поверхности сервиса наравне с порталом аккаунта, а Dockerfile
 * кладёт собранное в образ и задаёт DEVSITE_DIST — но отдавать его
 * было некому, и адрес отвечал 404.
 */
export async function registerDevsite(app: FastifyInstance): Promise<void> {
  const dist = devsiteDist();
  if (!dist) return;

  await app.register(fastifyStatic, {
    root: dist,
    prefix: "/dev/",
    // reply.sendFile уже добавлен регистрацией портала: второй раз
    // fastify-static декорировать ответ не даст.
    decorateReply: false,
    index: ["index.html"],
    // /dev без косой черты — на /dev/, иначе относительные ссылки
    // внутри страницы разъезжаются.
    redirect: true,
    // Справочник ГЕНЕРИРУЕТСЯ из спецификации и меняется вместе с
    // ней: immutable здесь означал бы устаревший справочник у того,
    // кто по нему пишет клиента.
    cacheControl: true,
    maxAge: 0,
  });

  // Сам /dev в префикс /dev/ не попадает: fastify-static заводит
  // маршруты под ним, но не на нём.
  app.get("/dev", async (_req, reply) => reply.redirect("/dev/", 302));
}

/**
 * Портал аккаунта: тот же собранный портал, другой начальный экран.
 * Экраны J1, K1, L1-L3, M1-M3, N1 — маршруты одного приложения.
 */
const ACCOUNT_SCREENS: Record<string, string> = {
  "": "Account",
  personal: "AccountPersonal",
  security: "AccountSecurity",
  devices: "AccountDevices",
  communications: "AccountCommunications",
  privacy: "AccountPrivacy",
};

export async function registerPortal(app: FastifyInstance): Promise<void> {
  const dist = portalDist();
  if (dist) {
    await app.register(fastifyStatic, {
      root: join(dist, "assets"),
      prefix: "/assets/",
      // Файлы собраны без хеша в имени, поэтому долгий кэш им нельзя:
      // после выкладки браузер обязан взять новые.
      cacheControl: true,
      maxAge: 0,
    });
  }

  app.get<{ Params: { "*"?: string } }>("/account", accountHandler);
  app.get<{ Params: { "*"?: string } }>("/account/*", accountHandler);

  async function accountHandler(
    req: { params: { "*"?: string }; query: unknown },
    reply: {
      type: (t: string) => { header: (k: string, v: string) => { send: (b: string) => unknown } };
    },
  ): Promise<unknown> {
    const section = (req.params["*"] ?? "").split("/")[0] ?? "";
    const screen = ACCOUNT_SCREENS[section] ?? "Account";
    const terms = await currentDocument("cmpas_terms");
    const returnTo = readReturnTo(req.query);
    return reply
      .type("text/html; charset=utf-8")
      // Портал показывает сведения об учётной записи — общим кэшам
      // и истории браузера их отдавать незачем.
      .header("cache-control", "no-store")
      .send(renderScreen(screen, {
        service: returnTo,
        termsVersion: terms?.version ?? "0.9",
      }));
  }
}

function readReturnTo(query: unknown): Product {
  const value = (query as { return_to?: unknown } | undefined)?.return_to;
  return value === "zapiski" || value === "moments" ? value : "practice";
}
