import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getPool, closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";
import { PORTAL_CLIENT, PORTAL_REDIRECT } from "../src/oidc/portalClient.js";
import { serviceOf } from "../src/oidc/interactions.js";

/**
 * Портал аккаунта — не продукт, и заголовок это признаёт.
 *
 * Человек набрал auth.cmpas.ru, чтобы попасть в СВОЙ АККАУНТ, и увидел
 * «Вход в ПРАКТИКУ». Он шёл не в ПРАКТИКУ. Клиент портала записан в
 * реестре с продуктом practice, и заголовок честно показывал колонку —
 * но показывал неправду.
 *
 * «Вход в аккаунт СИМПАС» — ОТСТУПЛЕНИЕ от дословного текста макета:
 * экрана входа в сам портал в макете нет. Отступление разрешено прямо
 * (решение учредителя 09.09.2026), а не додумано, — как и ШАГИ.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

function authUrl(clientId: string, redirect: string): string {
  return "/oidc/auth?" + new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirect,
    scope: "openid email",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "st", nonce: "nc",
  });
}

async function screenFor(clientId: string, redirect: string): Promise<string> {
  const start = await app.inject({ url: authUrl(clientId, redirect), headers: HOST });
  const uid = String(start.headers.location).replace("/interaction/", "");
  const cookies = (start.headers["set-cookie"] as string[] | undefined ?? [])
    .map((c) => c.split(";")[0]).join("; ");
  const r = await app.inject({ url: `/interaction/${uid}`, headers: { ...HOST, cookie: cookies } });
  return r.body;
}

beforeAll(async () => {
  await resetData();
  await ensureTestClient();
  await getPool().query(
    `INSERT INTO oidc_clients
       (client_id, client_name, client_secret, redirect_uris, auth_method, first_party, product)
     VALUES ($1, 'Аккаунт СИМПАС', NULL, ARRAY[$2], 'none', false, 'practice')
     ON CONFLICT (client_id) DO NOTHING`,
    [PORTAL_CLIENT, PORTAL_REDIRECT],
  );
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await getPool().query("DELETE FROM oidc_clients WHERE client_id = $1", [PORTAL_CLIENT]);
  if (app) await app.close();
  await closePool();
});

describe("заголовок экрана входа", () => {
  it("портал аккаунта не выдаёт себя за ПРАКТИКУ", async () => {
    const body = await screenFor(PORTAL_CLIENT, PORTAL_REDIRECT);
    expect(body).not.toContain("Вход в ПРАКТИКУ");
    expect(body).toContain("Вход в аккаунт СИМПАС");
  });

  it("продукт по-прежнему называется своим именем", async () => {
    const body = await screenFor("test", "https://ex.test/cb");
    expect(body).toContain("Вход в ПРАКТИКУ");
  });

  it("портал опознаётся по клиенту, а не по колонке продукта", async () => {
    // Колонка product у портала — practice, и менять её строкой в базе
    // ради заголовка значило бы чинить экран правкой данных.
    expect(await serviceOf(PORTAL_CLIENT)).toBe("account");
    expect(await serviceOf("test")).toBe("practice");
  });
});
