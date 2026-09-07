import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { createClient, findClient, generateClientSecret } from "../src/oidc/clients.js";

// oidc_clients — справочная таблица: resetData её намеренно не чистит,
// иначе тесты протокола потеряли бы своего клиента. Убираем за собой
// ровно те записи, которые заводим здесь.
const MINE = ["practice-web", "practice-mobile", "practice-dev"];
beforeEach(async () => {
  await resetData();
  await getPool().query("DELETE FROM oidc_clients WHERE client_id = ANY($1::text[])", [MINE]);
});
afterAll(async () => { await closePool(); });

const WEB = {
  clientId: "practice-web",
  clientName: "ПРАКТИКА",
  redirectUris: ["https://cmpas.ru/api/auth/callback/simpasid"],
  product: "practice" as const,
};

describe("регистрация клиента", () => {
  it("конфиденциальный клиент заводится и получает ключ", async () => {
    const created = await createClient(WEB);
    expect(created.clientSecret).toBeTruthy();
    expect(created.clientSecret!.length).toBeGreaterThanOrEqual(32);
    expect(created.authMethod).toBe("client_secret_basic");
    expect(created.firstParty).toBe(false);

    const found = await findClient("practice-web");
    expect(found?.redirectUris).toEqual(WEB.redirectUris);
    expect(found?.product).toBe("practice");
  });

  it("публичный клиент заводится без ключа", async () => {
    // Мобильному клиенту секрет не выдаётся вовсе: он живёт на чужом
    // устройстве, где секрета не спрячешь. Безопасность держится на
    // PKCE и одноразовости refresh.
    const created = await createClient({
      clientId: "practice-mobile", clientName: "ПРАКТИКА для Android",
      redirectUris: [], product: "practice", isPublic: true, firstParty: true,
    });
    expect(created.clientSecret).toBeNull();
    expect(created.authMethod).toBe("none");
    expect(created.firstParty).toBe(true);
  });

  it("first_party по умолчанию выключен", async () => {
    // Забыть эту проверку значит отдать всем желающим вход,
    // спроектированный в расчёте на доверенное приложение.
    expect((await createClient(WEB)).firstParty).toBe(false);
  });

  it("повторная регистрация того же идентификатора отклоняется", async () => {
    await createClient(WEB);
    await expect(createClient(WEB)).rejects.toThrow(/уже зарегистрирован/);
  });

  it("конфиденциальный клиент без адреса возврата не заводится", async () => {
    // Клиент без redirect_uri не сможет получить код: молчаливая
    // регистрация такого — отложенная поломка входа.
    await expect(createClient({ ...WEB, redirectUris: [] }))
      .rejects.toThrow(/адрес возврата/);
  });

  it("адрес возврата обязан быть https и без фрагмента", async () => {
    for (const bad of [
      "http://cmpas.ru/cb",
      "https://cmpas.ru/cb#frag",
      "не-адрес",
    ]) {
      await expect(createClient({ ...WEB, redirectUris: [bad] }))
        .rejects.toThrow(/адрес возврата/);
    }
  });

  it("localhost по http допускается: без него не отладить продукт", async () => {
    const c = await createClient({
      ...WEB, clientId: "practice-dev",
      redirectUris: ["http://localhost:3000/api/auth/callback/simpasid"],
    });
    expect(c.redirectUris).toHaveLength(1);
  });

  it("ключ каждый раз новый и достаточно длинный", async () => {
    const a = generateClientSecret();
    const b = generateClientSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it("запись видна провайдеру в том виде, какой он ждёт", async () => {
    await createClient(WEB);
    const { rows } = await getPool().query(
      "SELECT grant_types, response_types_ok FROM (SELECT grant_types, true AS response_types_ok FROM oidc_clients WHERE client_id = $1) t",
      ["practice-web"],
    );
    expect(rows[0]!.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });
});
