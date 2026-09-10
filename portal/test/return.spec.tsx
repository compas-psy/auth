import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Account } from "../src/screens/Account";
import { Personal } from "../src/screens/Personal";
import { Devices } from "../src/screens/Devices";

afterEach(() => cleanup());

/**
 * Дверь из кабинета обещается только тогда, когда она есть.
 *
 * Ссылка «вернуться в продукт» стояла на каждом экране и вела в
 * /return/…, маршрута для которого на сервере не было: 404. При этом
 * продукт назывался ПРАКТИКОЙ даже тому, кто ни из какого продукта не
 * приходил, — он набрал auth.cmpas.ru, чтобы посмотреть свою учётную
 * запись.
 */

const profile = {
  id: "acc_1", email: "t…v@ya.ru", email_verified: true,
  display_name: "Илья", products: ["practice" as const],
};

function backLink(): HTMLAnchorElement | null {
  return document.querySelector("a.back-link");
}

describe("выход из кабинета", () => {
  it("пришедшего из продукта зовут обратно в ЕГО продукт", () => {
    render(<Devices sessions={[]} returnTo="practice" />);
    const link = backLink()!;
    expect(link.textContent).toContain("Вернуться в ПРАКТИКУ");
    expect(link.getAttribute("href")).toBe("/return/practice");
  });

  it("пришедшему самому не выдумывают продукт", () => {
    render(<Devices sessions={[]} returnTo={null} />);
    const link = backLink()!;
    expect(link.textContent).not.toContain("ПРАКТИК");
    expect(link.getAttribute("href")).toBe("/account");
  });

  it("на обзоре аккаунта ссылки на себя нет", () => {
    render(<Account profile={profile} products={[]} returnTo={null} />);
    expect(backLink()).toBeNull();
  });

  it("обзор всё равно возвращает в продукт, если человек оттуда", () => {
    render(<Account profile={profile} products={[]} returnTo="practice" />);
    expect(backLink()?.getAttribute("href")).toBe("/return/practice");
  });

  it("продукт без известного адреса кнопкой «Открыть» не притворяется", () => {
    // У МОМЕНТОВ адреса пока нет — решение учредителя 10.09.2026.
    render(
      <Account profile={profile} returnTo={null}
        products={[{ code: "moments", since: "2026" }]} />,
    );
    expect(screen.queryByText("Открыть")).toBeNull();
  });

  it("у продукта с адресом «Открыть» есть", () => {
    render(
      <Account profile={profile} returnTo={null}
        products={[{ code: "practice", since: "2026" }]} />,
    );
    expect(screen.getByText("Открыть").getAttribute("href")).toBe("/return/practice");
  });

  it("указатель в ПРАКТИКУ на личных данных ведёт в существующий адрес", () => {
    render(<Personal profile={profile} emails={[]} returnTo={null} />);
    expect(screen.getByText("Открыть ПРАКТИКУ").getAttribute("href")).toBe("/return/practice");
  });
});

/**
 * Перечень продуктов в кабинете берётся из реестра имён.
 *
 * Он был вписан в вёрстку тремя строками — practice, zapiski, moments, —
 * и ШАГИ в кабинете не показывались вовсе: продукт добавили миграцией и
 * словарём, а этот список остался прежним. Отказа не было: продукта
 * просто не существовало для человека.
 */
describe("перечень продуктов", () => {
  it("показывает ВСЕ продукты экосистемы, включая ШАГИ", () => {
    render(<Account profile={profile} products={[]} returnTo={null} />);
    for (const name of ["ПРАКТИКА", "ЗАПИСКИ", "МОМЕНТЫ", "ШАГИ"]) {
      expect(screen.getByText(name), `${name} нет в перечне`).toBeVisible();
    }
  });

  it("о неподключённом продукте говорится прямо", () => {
    render(<Account profile={profile} products={[]} returnTo={null} />);
    expect(screen.getAllByText("не подключены")).toHaveLength(4);
  });
});
