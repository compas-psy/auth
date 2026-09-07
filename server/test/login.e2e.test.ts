import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader } from "jose";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData, ensureTestClient } from "./helpers.js";
import { buildServer } from "../src/index.js";

/**
 * Вход НАСКВОЗЬ: от /oidc/auth до проверенного id_token.
 *
 * Отдельные звенья были покрыты и раньше, но целиком путь не проходил
 * ни один тест: он обрывался на возврате к провайдеру. А продукт
 * получает личность именно в конце — из id_token, подписанного нашим
 * ключом. Разрыв в любом звене виден только тому, кто уже нажал кнопку.
 */

let app: FastifyInstance;
const HOST = { host: "auth.cmpas.ru", "x-forwarded-proto": "https" };

// Пара из RFC 7636, приложение B: проверочный код и его S256-образ.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "https://ex.test/cb";
const SECRET = "t".repeat(43);

/**
 * Копилка cookie на всю цепочку.
 *
 * Провайдер ведёт взаимодействие ТРЕМЯ cookie: сессия, взаимодействие
 * и возобновление. Они ставятся на разных шагах, и если на очередном
 * шаге заменить набор вместо дополнения, провайдер теряет сессию и
 * отвечает 404 — что и случилось при первом прогоне этого теста.
 * Браузер копит их, значит копит и тест.
 */
class Jar {
  private readonly jar = new Map<string, string>();

  take(r: { headers: Record<string, unknown> }): void {
    const raw = r.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
    for (const line of list) {
      const pair = String(line).split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Пустое значение — это удаление cookie, как в браузере.
      if (value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  get header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

beforeAll(async () => {
  await resetData(); await ensureTestClient();
  app = await buildServer(); await app.ready();
});
afterAll(async () => { await app.close(); await closePool(); });

describe("вход насквозь: от кнопки до id_token", () => {
  it("почта → ссылка → код → токен, подписанный нашим ключом", async () => {
    // 1. Продукт уводит человека к нам.
    const params = new URLSearchParams({
      client_id: "test", response_type: "code", redirect_uri: REDIRECT,
      scope: "openid email", code_challenge: CHALLENGE,
      code_challenge_method: "S256", state: "st-42", nonce: "nc-42",
    });
    const jar = new Jar();
    const auth = await app.inject({ url: `/oidc/auth?${params}`, headers: HOST });
    expect(auth.statusCode).toBe(303);
    const uid = String(auth.headers.location).replace("/interaction/", "");
    jar.take(auth);

    // 2. Человек называет почту. Ответ одинаков для известной и
    //    неизвестной — здесь нас интересует только, что письмо выпущено.
    const started = await app.inject({
      method: "POST", url: `/interaction/${uid}/email`,
      headers: { ...HOST, cookie: jar.header }, payload: { email: "e2e@ya.ru" },
    });
    expect(started.statusCode).toBeLessThan(400);
    jar.take(started);
    const { rows } = await getPool().query("SELECT token_hash FROM magic_link_tokens");
    expect(rows).toHaveLength(1);

    // 3. Ссылка из письма. Сырой токен знает только владелец почты —
    //    в тесте берём его из выпуска, как человек берёт из письма.
    const { issueMagicLink } = await import("../src/services/magicLink.js");
    await getPool().query("DELETE FROM magic_link_tokens");
    const issued = await issueMagicLink({
      email: "e2e@ya.ru", deviceKey: uid, platform: "web", termsVersion: "0.9" });
    if ("throttled" in issued) throw new Error("не ожидали паузы");

    const back = await app.inject({
      url: `/interaction/${uid}/callback?token=${issued.token}`,
      headers: { ...HOST, cookie: jar.header },
    });
    expect(back.statusCode).toBe(303);
    jar.take(back);

    // 4. Провайдер доводит разрешение и возвращает код продукту.
    let location = String(back.headers.location);
    let redirect: string | undefined;
    const shownScreens: number[] = [];
    for (let hop = 0; hop < 6 && !redirect; hop += 1) {
      const step = await app.inject({ url: location, headers: { ...HOST, cookie: jar.header } });
      jar.take(step);
      location = String(step.headers.location ?? "");
      // Человек не видит ни экрана разрешения, ни слова «scope»:
      // договор принимается действием на экране входа, а разрешение
      // своему клиенту выдаётся без отдельного вопроса.
      // Ответ, отличный от перенаправления, — это показанный экран.
      if (step.statusCode !== 303 && step.statusCode !== 302) shownScreens.push(hop);
      // И слов «OAuth», «scope», «разрешения» человек не видит нигде.
      for (const word of ["Разрешить", "scope", "OAuth"]) {
        expect({ hop, word, found: String(step.body ?? "").includes(word) })
          .toEqual({ hop, word, found: false });
      }
      if (location.startsWith(REDIRECT)) redirect = location;
      else expect({ hop, code: step.statusCode, location })
        .toEqual({ hop, code: step.statusCode, location: expect.stringMatching(/^https?:\/\/|^\//) as unknown as string });
    }
    expect(redirect, "провайдер не вернул продукт на redirect_uri").toBeDefined();
    // Смысл не в числе переходов, а в том, что человека ни на одном
    // из них не останавливают экраном: после ссылки из письма он
    // просто оказывается в продукте.
    expect(shownScreens, "человеку показали лишний экран после входа").toEqual([]);

    const returned = new URL(redirect!);
    expect(returned.searchParams.get("state"), "state не вернулся — CSRF-защита продукта")
      .toBe("st-42");
    const code = returned.searchParams.get("code");
    expect(code, "код авторизации не выдан").toBeTruthy();

    // 5. Продукт меняет код на токены. Без проверочного кода PKCE
    //    обмен обязан не состояться.
    const exchange = async (verifier: string | null) => app.inject({
      method: "POST", url: "/oidc/token", headers: {
        ...HOST,
        authorization: `Basic ${Buffer.from(`test:${SECRET}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT,
        ...(verifier ? { code_verifier: verifier } : {}),
      }).toString(),
    });

    const withoutPkce = await exchange(null);
    expect(withoutPkce.statusCode).toBeGreaterThanOrEqual(400);

    const tokens = await exchange(VERIFIER);
    expect(tokens.statusCode, tokens.body).toBe(200);
    const body = tokens.json() as { id_token?: string; access_token?: string };
    expect(body.id_token, "id_token не выдан").toBeTruthy();

    // 6. Продукт проверяет подпись по jwks_uri из метаданных — так же,
    //    как это сделает next-auth. Ключ не подкладывается из теста.
    const jwks = (await app.inject({ url: "/oidc/jwks", headers: HOST })).json();
    const verified = await jwtVerify(body.id_token!, createLocalJWKSet(jwks), {
      issuer: "https://auth.cmpas.ru", audience: "test",
    });

    expect(decodeProtectedHeader(body.id_token!).alg).not.toBe("none");
    expect(verified.payload.nonce, "nonce не вернулся — защита от повтора").toBe("nc-42");
    expect(verified.payload.sub, "нет sub — продукту не по чему опознать человека").toBeTruthy();
    expect(verified.payload.email).toBe("e2e@ya.ru");
  });

  it("в id_token нет ни ролей, ни тарифов, ни ФИО", async () => {
    // CLAUDE.md: продукт узнаёт права из своей базы по sub. Роль,
    // приехавшая в токене, немедленно станет источником истины.
    const { rows } = await getPool().query<{ payload: unknown }>(
      "SELECT payload FROM oidc_payloads WHERE type = 'IdToken' LIMIT 1");
    const dump = JSON.stringify(rows[0]?.payload ?? {});
    for (const forbidden of ["role", "roles", "tariff", "plan", "psychologist", "name", "phone"]) {
      expect({ forbidden, found: dump.includes(`"${forbidden}"`) })
        .toEqual({ forbidden, found: false });
    }
  });
});
