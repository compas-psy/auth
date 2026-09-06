import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/index.js";
import { closePool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

const AUTH = "/oidc/auth?" + new URLSearchParams({
  client_id: "test", response_type: "code", redirect_uri: "https://ex.test/cb",
  scope: "openid email", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256", state: "st", nonce: "nc",
});

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

function providerSource(): string {
  return readFileSync(new URL("../src/oidc/provider.ts", import.meta.url), "utf8");
}

async function cookies(): Promise<string[]> {
  const r = await app.inject({ url: AUTH, headers: HOST });
  const raw = r.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
}

describe("Р-2: cookie не поднимается на общий домен", () => {
  it("ни одна cookie не имеет атрибута Domain", async () => {
    const set = await cookies();
    expect(set.length).toBeGreaterThan(0);
    for (const c of set) {
      expect({ cookie: c.split("=")[0], hasDomain: /Domain=/i.test(c) })
        .toEqual({ cookie: c.split("=")[0], hasDomain: false });
    }
  });

  it("каждая cookie помечена HttpOnly, Secure и SameSite=Lax", async () => {
    for (const c of await cookies()) {
      const name = c.split("=")[0];
      expect({ name, httpOnly: /HttpOnly/i.test(c) }).toEqual({ name, httpOnly: true });
      expect({ name, secure: /Secure/i.test(c) }).toEqual({ name, secure: true });
      expect({ name, lax: /SameSite=Lax/i.test(c) }).toEqual({ name, lax: true });
    }
  });

  it("cookie сессии SSO использует префикс __Host-", () => {
    // Именно она даёт право сменить способ входа, и именно ради неё
    // написано требование Р-2. Префикс __Host- запрещён к применению
    // вместе с атрибутом Domain на уровне браузера и потому сам
    // страхует от ошибки.
    //
    // Проверяется по конфигурации, а не по ответу: cookie сессии
    // ставится только после успешного входа, и наблюдение за одним
    // ответом её не поймает.
    expect(providerSource()).toContain('session: "__Host-simpas_session"');
  });

  it("cookie взаимодействия не носят префикс __Host-, и это не ошибка", async () => {
    // Библиотека выдаёт их с суженным Path
    // (lib/actions/authorization/interactions.js), а браузер отвергает
    // __Host- при любом Path, кроме «/». Domain у них всё равно нет.
    for (const c of await cookies()) {
      if (/^__Host-/.test(c)) {
        expect({ cookie: c.split("=")[0], rootPath: /Path=\/;/.test(c) })
          .toEqual({ cookie: c.split("=")[0], rootPath: true });
      }
      expect(/Domain=/i.test(c)).toBe(false);
    }
  });

  it("в конфигурации нигде не задан домен cookie", () => {
    // Задать Domain можно только явно, и явного задания здесь быть
    // не должно ни при каких будущих правках.
    expect(providerSource()).not.toMatch(/domain\s*:/i);
  });
});
