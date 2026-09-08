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

  it("cookie взаимодействия доезжают до постоянного адреса возврата", async () => {
    // Раньше здесь стояло «префикса __Host- у них нет, и это не
    // ошибка»: библиотека выдавала их с Path=/interaction/<uid>. Это
    // была не особенность, а ДЕФЕКТ. Возврат от внешнего сервиса
    // приходит на /callback/<провайдер> — постоянный адрес, uid в него
    // не вставить, — и суженную cookie браузер туда не отправлял.
    // Вход через Яндекс падал на боевом с экраном «Вход временно
    // недоступен», а проверка была зелёной, потому что отбрасывала Path.
    for (const c of await cookies()) {
      const name = c.split("=")[0]!;
      const root = /path=\/;/i.test(c);
      // Префикс __Host- допустим ТОЛЬКО при Path=«/». Поставить его на
      // cookie с узким путём — не усиление, а выброшенная браузером
      // cookie и сломанный шаг. Одна такая правка едва не уехала в бой.
      expect({ name, prefixMatchesPath: name.startsWith("__Host-") === root })
        .toEqual({ name, prefixMatchesPath: true });
      expect(/Domain=/i.test(c)).toBe(false);
    }
  });

  it("cookie взаимодействия доходит до корня, иначе возврат теряется", async () => {
    const interaction = (await cookies())
      .filter((c) => c.includes("simpas_interaction=") || c.includes("simpas_interaction.sig="));
    expect(interaction.length).toBeGreaterThan(0);
    for (const c of interaction) {
      expect({ c: c.split("=")[0], root: /path=\/;/i.test(c) })
        .toEqual({ c: c.split("=")[0], root: true });
    }
  });

  it("Р-2: домен не задан ни у одной cookie", async () => {
    // Путь расширился до «/», но хост остался один: auth.cmpas.ru.
    // Cookie сервиса идентичности не имеет права уехать в продукт.
    for (const c of await cookies()) {
      expect({ c: c.split("=")[0], domain: /Domain=/i.test(c) })
        .toEqual({ c: c.split("=")[0], domain: false });
    }
  });

  it("в конфигурации нигде не задан домен cookie", () => {
    // Задать Domain можно только явно, и явного задания здесь быть
    // не должно ни при каких будущих правках.
    expect(providerSource()).not.toMatch(/domain\s*:/i);
  });
});
