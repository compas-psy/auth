import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Переходы внутри кабинета не перезагружают страницу.
 *
 * Учредитель нажимал карточки, и «ничего не происходило»: адрес менялся
 * на /account/communications, а на экране оставался обзор.
 *
 * Причина не в кнопках. Карточки были обычными ссылками, то есть полной
 * перезагрузкой. Ключ доступа живёт В ПАМЯТИ ВКЛАДКИ — перезагрузка его
 * теряет, портал молча входит заново и возвращается на
 * /account/callback, а этому адресу сервер отдаёт ОБЗОР. Дальше адрес
 * переписывался на нужный, и получалось расхождение: строка адреса про
 * один экран, содержимое про другой.
 *
 * Проверено в настоящем браузере (Chromium, локальный сервер за TLS) —
 * здесь закреплено, чтобы не вернулось.
 */

vi.mock("../src/auth/oidc", () => ({
  currentToken: () => "ключ-в-памяти",
  forgetToken: vi.fn(),
  beginAuthorization: vi.fn(async () => "/oidc/auth"),
  completeCallback: vi.fn(async () => "/account"),
  PORTAL_CLIENT_ID: "account-portal",
  PORTAL_REDIRECT_PATH: "/account/callback",
}));

const profile = {
  id: "acc_1", email: "t…v@ya.ru", email_verified: true,
  display_name: "Илья", products: [] as const,
};

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>();
  return {
    ...actual,
    api: {
      getAccount: vi.fn(async () => profile),
      listEmails: vi.fn(async () => ({ emails: [] })),
      listIdentities: vi.fn(async () => ({ identities: [] })),
      listSessions: vi.fn(async () => ({ sessions: [] })),
      getConsents: vi.fn(async () => ({ communications: [], accepted_documents: [] })),
    },
  };
});

const { AccountApp, screenForPath } = await import("../src/AccountApp");

beforeEach(() => { history.replaceState(null, "", "/account"); });
afterEach(() => cleanup());

describe("адрес и экран кабинета", () => {
  it("каждому разделу — свой экран", () => {
    expect(screenForPath("/account")).toBe("Account");
    expect(screenForPath("/account/")).toBe("Account");
    expect(screenForPath("/account/personal")).toBe("AccountPersonal");
    expect(screenForPath("/account/communications")).toBe("AccountCommunications");
    expect(screenForPath("/account/devices")).toBe("AccountDevices");
    expect(screenForPath("/account/privacy")).toBe("AccountPrivacy");
    expect(screenForPath("/account/security")).toBe("AccountSecurity");
  });

  it("возврат от входа не считается разделом", () => {
    // Именно здесь и ломалось: /account/callback — не раздел, и сервер
    // честно отдаёт обзор. Экран обязан взять адрес, куда человек шёл.
    expect(screenForPath("/account/callback")).toBe("Account");
  });

  it("выдуманный раздел открывает обзор, а не пустоту", () => {
    expect(screenForPath("/account/нет-такого")).toBe("Account");
  });
});

describe("нажатие карточки", () => {
  it("открывает раздел, а не оставляет обзор", async () => {
    render(<AccountApp screen="Account" returnTo={null} />);
    await waitFor(() => expect(screen.getByText("Аккаунт СИМПАС")).toBeVisible());

    await userEvent.click(screen.getByText("Коммуникации"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Коммуникации");
    });
    expect(location.pathname).toBe("/account/communications");
  });

  it("«назад» браузера возвращает на обзор", async () => {
    render(<AccountApp screen="Account" returnTo={null} />);
    await waitFor(() => expect(screen.getByText("Аккаунт СИМПАС")).toBeVisible());
    await userEvent.click(screen.getByText("Личные данные"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Личные данные");
    });

    history.back();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Аккаунт СИМПАС");
    });
  });
});
