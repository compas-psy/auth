import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { resetData } from "./helpers.js";
import { PRODUCTS, type Product } from "../src/services/accounts.js";
import { PRODUCT_NAMES, PRODUCT_ACCUSATIVE, signIn, account } from "../src/ui/wording.js";

/**
 * ШАГИ — четвёртый продукт экосистемы.
 *
 * До этой правки ограничение схемы допускало ровно три кода, и завести
 * клиента ШАГОВ было нельзя: запись отвергалась базой. Ограничение —
 * не формальность: оно не даёт связать аккаунт с продуктом, которого
 * система не знает.
 */

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

describe("ШАГИ приняты схемой", () => {
  it("связь аккаунта с ШАГАМИ записывается", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO accounts (display_name) VALUES (NULL) RETURNING id");
    await expect(getPool().query(
      "INSERT INTO product_links (account_id, product, product_user_id) VALUES ($1,'steps','u-1')",
      [rows[0]!.id],
    )).resolves.toBeDefined();
  });

  it("клиент ШАГОВ регистрируется", async () => {
    const { createClient } = await import("../src/oidc/clients.js");
    await getPool().query("DELETE FROM oidc_clients WHERE client_id = 'steps-web'");
    const c = await createClient({
      clientId: "steps-web", clientName: "ШАГИ", product: "steps",
      redirectUris: ["https://steps.cmpas.ru/api/auth/callback/simpasid"],
    });
    expect(c.product).toBe("steps");
  });

  it("выдуманный продукт по-прежнему отвергается базой", async () => {
    // Ограничение расширено, а не снято: опечатка в коде продукта не
    // должна тихо заводить четвёртую сущность.
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO accounts (display_name) VALUES (NULL) RETURNING id");
    await expect(getPool().query(
      "INSERT INTO product_links (account_id, product, product_user_id) VALUES ($1,'shagi','u-2')",
      [rows[0]!.id],
    )).rejects.toThrow();
  });
});

describe("ШАГИ известны коду и экранам", () => {
  it("продукт входит в перечень", () => {
    expect(PRODUCTS).toContain("steps" as Product);
  });

  it("у продукта есть имя и винительный падеж", () => {
    // Без падежа экран сказал бы «Вход в undefined».
    expect(PRODUCT_NAMES).toHaveProperty("steps");
    expect(PRODUCT_ACCUSATIVE).toHaveProperty("steps");
  });

  it("экран входа называет ШАГИ, а не подставляет пустоту", () => {
    expect(signIn.title("steps")).toBe("Вход в ШАГИ");
    expect(account.backTo("steps")).toBe("Вернуться в ШАГИ");
  });

  it("ни один продукт не остался без падежа", () => {
    for (const p of PRODUCTS) {
      expect({ p, ok: Boolean(PRODUCT_ACCUSATIVE[p]) }).toEqual({ p, ok: true });
    }
  });
});

describe("завести клиента ШАГОВ можно из репозитория", () => {
  /**
   * Р-3: учредитель ничего не прописывает руками. Продукт, которого
   * нет в списке выбора, руками и завёлся бы — через psql на боевом
   * сервере. Список в оболочке и перечень в коде обязаны совпадать,
   * иначе расхождение обнаруживается в момент, когда клиент нужен.
   */
  it("оболочка регистрации предлагает ровно те продукты, что знает код", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const yml = readFileSync(join(here, "../../.github/workflows/client.yml"), "utf8");
    const line = yml.split("\n").find((l) => l.includes("options:"));
    expect(line, "в оболочке нет списка продуктов").toBeDefined();
    const offered = line!.slice(line!.indexOf("[") + 1, line!.indexOf("]"))
      .split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(offered).toEqual([...PRODUCTS].sort());
  });

  it("подсказка командной строки называет все продукты", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = readFileSync(join(here, "../src/cli/clients.ts"), "utf8");
    for (const p of PRODUCTS) {
      expect({ p, mentioned: cli.includes(p) }).toEqual({ p, mentioned: true });
    }
  });
});

describe("ШАГИ названы человеку на экранах", () => {
  /**
   * Решение учредителя от 07.09.2026: ШАГИ — наш продукт, и человек
   * должен видеть его в перечне. Это ОТСТУПЛЕНИЕ от дословного текста
   * макета (08_AUTH_DESIGN_BRIEF.md §268, 09_ACCOUNT_DESIGN_ADDENDUM.md
   * §240), где продуктов три. Отступление разрешено прямо и записано
   * здесь, чтобы следующий читатель не «починил» его обратно по макету.
   *
   * Перечень СОБИРАЕТСЯ из списка продуктов, а не переписывается руками:
   * ровно поэтому ШАГИ и пришлось дописывать в четырёх местах сегодня.
   */
  it("подпись экрана входа называет каждый продукт", () => {
    for (const p of PRODUCTS) {
      expect({ p, named: signIn.subtitle.includes(PRODUCT_NAMES[p]) })
        .toEqual({ p, named: true });
    }
  });

  it("подпись портала называет каждый продукт в винительном падеже", () => {
    for (const p of PRODUCTS) {
      expect({ p, named: account.subtitle.includes(PRODUCT_ACCUSATIVE[p]) })
        .toEqual({ p, named: true });
    }
  });

  it("подписи собраны из перечня, а не вписаны буквами", () => {
    // Иначе пятый продукт снова придётся искать по всему коду глазами.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/ui/wording.ts"), "utf8");
    for (const literal of ["ПРАКТИКА, ЗАПИСКИ", "ПРАКТИКУ, ЗАПИСКИ"]) {
      expect({ literal, hardcoded: src.includes(literal) })
        .toEqual({ literal, hardcoded: false });
    }
  });

  it("подписи читаются по-русски, а не через запятую до конца", () => {
    expect(signIn.subtitle).toBe("Один аккаунт СИМПАС — ПРАКТИКА, ЗАПИСКИ, МОМЕНТЫ, ШАГИ.");
    expect(account.subtitle).toBe("Один аккаунт на ПРАКТИКУ, ЗАПИСКИ, МОМЕНТЫ и ШАГИ.");
  });
});
