import { describe, it, expect, afterEach, vi } from "vitest";
import { YandexError } from "../src/services/providers/yandex.js";
import { VkidError } from "../src/services/providers/vkid.js";
import { exchangeFailureStage } from "../src/api/v1/auth.js";

/**
 * Стадия отказа обмена — в журнал сервиса.
 *
 * Просьба агента ПРАКТИКИ (issue compas-psy/auth#27, 11.09.2026):
 * снаружи «подпись не сошлась», «профиль недоступен» и «в профиле нет
 * идентификатора» выглядят одинаково — `invalid_provider_code`, — и
 * каждый разбор начинается с гадания. Первый же живой вход через
 * Яндекс не прошёл, и сказать почему было нечем.
 *
 * ПОЧЕМУ НЕ НАРУЖУ. Ответ человеку остаётся прежним: различать отказы
 * в ответе значит рассказывать подбирающему, насколько он близок.
 * Стадия — машинное слово для НАШЕГО журнала.
 *
 * ПОЧЕМУ НЕ В audit_log. Тот журнал человек видит в списке устройств и
 * сеансов; стадия обмена ему ничего не говорит. Отладочная подробность
 * живёт в логе сервиса, а не в пользовательском журнале.
 *
 * Ни адреса, ни идентификатора, ни токена стадия не содержит: это одно
 * из четырёх слов.
 */

afterEach(() => vi.unstubAllEnvs());

describe("стадия отказа обмена", () => {
  it("у Яндекса берётся из его же ошибки", () => {
    expect(exchangeFailureStage(new YandexError("x", "return"))).toBe("return");
    expect(exchangeFailureStage(new YandexError("x", "token"))).toBe("token");
    expect(exchangeFailureStage(new YandexError("x", "profile"))).toBe("profile");
  });

  it("у ВК тоже", () => {
    expect(exchangeFailureStage(new VkidError("x", "userinfo"))).toBe("userinfo");
  });

  it("чужая ошибка не притворяется стадией", () => {
    // Иначе «unknown» стало бы самой частой стадией в журнале, и
    // журнал перестал бы отвечать на вопрос, ради которого заведён.
    expect(exchangeFailureStage(new Error("что-то не то"))).toBe("unknown");
    expect(exchangeFailureStage("строка")).toBe("unknown");
  });

  it("в стадию не попадает текст ошибки", () => {
    // Текст может содержать что угодно, включая присланное извне.
    const stage = exchangeFailureStage(new YandexError("chelovek@cmpas.ru", "profile"));
    expect(stage).toBe("profile");
    expect(stage).not.toContain("@");
  });
});
