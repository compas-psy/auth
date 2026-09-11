import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignIn } from "../src/screens/SignIn";
import { CheckEmail } from "../src/screens/CheckEmail";
import { EnterCode } from "../src/screens/EnterCode";
import { EmailRequired } from "../src/screens/EmailRequired";
import { SignInUnavailable, IdentityTaken } from "../src/screens/Errors";
import { signIn } from "@wording";

const base = {
  service: "practice" as const,
  providers: [] as const,
  termsVersion: "0.9",
  onSubmitEmail: vi.fn(),
};

describe("экран входа: юридическая конструкция", () => {
  it("на экране нет ни одного обязательного чекбокса", () => {
    render(<SignIn {...base} providers={["yandex"]} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("Политика упомянута без глагола принятия", () => {
    render(<SignIn {...base} providers={["yandex"]} />);
    const legal = screen.getByTestId("legal-line").textContent ?? "";
    expect(legal).toContain("принимаете Пользовательское соглашение");
    expect(legal).toContain("Политике обработки персональных данных");
    expect(legal).not.toMatch(/принима\w+ Политик/i);
  });

  it("редакция принимаемого документа НЕ называется", () => {
    // Решение учредителя 07.09.2026. В макете этой надписи нет — она
    // была дописана в реализации. Ссылка ниже по-прежнему ведёт на
    // конкретную редакцию: доказательство — она и запись в журнале
    // согласий, а не текст на экране.
    render(<SignIn {...base} providers={["yandex"]} />);
    expect(screen.getByTestId("legal-line").textContent).not.toContain("редакция");
  });

  it("ссылки ведут на конкретную редакцию, а не на текущую", () => {
    render(<SignIn {...base} providers={["yandex"]} />);
    const legal = screen.getByTestId("legal-line");
    const links = within(legal).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href")))
      .toEqual(["/legal/terms/0.9", "/legal/privacy/0.9"]);
  });

  it("юридическая строка стоит под обоими блоками, а не только под почтой", () => {
    // Строка под одной формой оставляет кнопки провайдеров без указания
    // на принимаемый документ (задание 08 §2.5).
    const { container } = render(<SignIn {...base} providers={["yandex", "tid"]} />);
    const order = Array.from(
      container.querySelectorAll("[data-block], [data-testid='legal-line']"),
    ).map((el) => el.getAttribute("data-block") ?? "legal");
    expect(order).toEqual(["providers", "email", "legal"]);
  });

  it("почта видна без раскрытия свёртки", () => {
    render(<SignIn {...base} providers={["yandex", "tid", "sberid", "vkid"]} />);
    expect(screen.getByLabelText("Электронная почта")).toBeVisible();
  });

  it("свёртки «другие способы входа» на экране нет", () => {
    const { container } = render(<SignIn {...base} providers={["yandex", "tid"]} />);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Другие способы входа/i)).toBeNull();
  });

  it("строка про провайдера присутствует всегда", () => {
    render(<SignIn {...base} providers={["yandex"]} />);
    expect(screen.getByText(/Провайдер увидит, что вы вошли в СИМПАС/)).toBeVisible();
  });

  it("строка про провайдера остаётся и когда провайдеров нет", () => {
    render(<SignIn {...base} providers={[]} />);
    expect(screen.getByText(/Провайдер увидит, что вы вошли в СИМПАС/)).toBeVisible();
  });

  it("блок провайдеров не разваливается при одном подключённом", () => {
    const { container } = render(<SignIn {...base} service="zapiski" providers={["yandex"]} />);
    expect(container.querySelectorAll("[data-provider]")).toHaveLength(1);
  });

  it("блок провайдеров не разваливается при четырёх", () => {
    const { container } = render(
      <SignIn {...base} providers={["yandex", "tid", "sberid", "vkid"]} />);
    expect(container.querySelectorAll("[data-provider]")).toHaveLength(4);
  });

  it("провайдеры идут первым блоком, почта вторым", () => {
    const { container } = render(<SignIn {...base} providers={["yandex"]} />);
    const blocks = Array.from(container.querySelectorAll("[data-block]"))
      .map((el) => el.getAttribute("data-block"));
    expect(blocks).toEqual(["providers", "email"]);
  });

  it("человек видит, куда он входит", () => {
    render(<SignIn {...base} service="practice" providers={[]} />);
    expect(screen.getByRole("heading", { name: "Вход в ПРАКТИКУ" })).toBeVisible();
  });

  it("и не видит на входе ничего про остальную экосистему", () => {
    // Решение учредителя 09.09.2026 по новому пакету макетов: человек
    // входит в КОНКРЕТНЫЙ продукт. Перечень продуктов остался в
    // портале аккаунта, где он уже вошёл и перечень по делу.
    const { container } = render(<SignIn {...base} service="practice" providers={[]} />);
    expect(container.textContent).not.toContain("Один аккаунт");
  });

  it("ни одна кнопка провайдера не выделена среди других", () => {
    const { container } = render(
      <SignIn {...base} providers={["yandex", "tid", "sberid", "vkid"]} />);
    const classes = new Set(
      Array.from(container.querySelectorAll("[data-provider]")).map((el) => el.className));
    expect(classes.size).toBe(1);
  });

  it("на мобильном кнопка обещает код, а не ссылку", () => {
    render(<SignIn {...base} platform="android" providers={[]} />);
    expect(screen.getByRole("button", { name: "Получить код для входа" })).toBeVisible();
  });

  it("рекламных переключателей на экране входа нет", () => {
    render(<SignIn {...base} providers={["yandex"]} />);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});

describe("экран входа: запрещённые слова", () => {
  const FORBIDDEN = [
    "OAuth", "токен", "OIDC", "SimpasID", "провайдер идентичности", "ПДн", "субъект",
  ];
  it("ни одного технического слова из запрещённого списка", () => {
    const { container } = render(
      <SignIn {...base} providers={["yandex", "tid", "sberid", "vkid"]} />);
    const text = container.textContent ?? "";
    for (const word of FORBIDDEN) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("ни одного обещания про шифрование и «мы не можем прочитать»", () => {
    const { container } = render(<SignIn {...base} providers={["yandex"]} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/шифр/i);
    expect(text).not.toMatch(/не можем прочитать/i);
  });
});

describe("экран «Проверьте почту» (B2)", () => {
  it("адрес показан частично скрытым, текст дословный", () => {
    render(<CheckEmail maskedEmail="t…v@ya.ru" secondsLeft={60} onResend={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Проверьте почту" })).toBeVisible();
    expect(screen.getByText("Мы отправили ссылку для входа на t…v@ya.ru.")).toBeVisible();
    expect(screen.getByText("Ссылка действует 15 минут и открывается один раз.")).toBeVisible();
    expect(screen.getByText("Письма нет? Загляните в «Спам» или измените адрес.")).toBeVisible();
  });

  it("«Отправить снова» неактивна, пока идёт пауза", () => {
    render(<CheckEmail maskedEmail="t…v@ya.ru" secondsLeft={42} onResend={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Отправить снова/ })).toBeDisabled();
  });

  it("после паузы кнопка активна", () => {
    render(<CheckEmail maskedEmail="t…v@ya.ru" secondsLeft={0} onResend={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Отправить снова" })).toBeEnabled();
  });
});

describe("экран ввода кода (A6н)", () => {
  it("шесть ячеек и счётчик попыток", () => {
    const { container } = render(
      <EnterCode maskedEmail="t…v@ya.ru" secondsLeft={0} attemptsLeft={4}
        onSubmit={vi.fn()} onResend={vi.fn()} />);
    expect(container.querySelectorAll("[data-code-cell]")).toHaveLength(6);
    expect(screen.getByText("Осталось попыток: 4.")).toBeVisible();
  });

  it("исчерпание попыток говорит, что делать дальше", () => {
    render(<EnterCode maskedEmail="t…v@ya.ru" secondsLeft={0} attemptsLeft={0}
      burned onSubmit={vi.fn()} onResend={vi.fn()} />);
    expect(screen.getByText("Попытки исчерпаны. Запросите новый код.")).toBeVisible();
  });
});

describe("экран C2 — провайдер не отдал почту", () => {
  it("объясняет, зачем почта, и не обвиняет человека", () => {
    render(<EmailRequired provider="yandex" onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Нужна электронная почта" })).toBeVisible();
    expect(screen.getByText(/Яндекс ID не передал подтверждённый адрес почты/)).toBeVisible();
    expect(screen.getByText(/даже если доступ к Яндекс ID пропадёт/)).toBeVisible();
  });
});

describe("экраны отказов C3 и C4", () => {
  it("C4: человеческий текст, а не техническая ошибка", () => {
    render(<SignInUnavailable service="practice" />);
    expect(screen.getByText("Вход временно недоступен. Мы уже чиним.")).toBeVisible();
    expect(screen.getByText("Попробуйте через несколько минут.")).toBeVisible();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("C4 для ЗАПИСОК добавляет вторую строку", () => {
    render(<SignInUnavailable service="zapiski" />);
    expect(screen.getByText("Заметки на этом устройстве работают как обычно.")).toBeVisible();
  });

  it("C4 для ПРАКТИКИ второй строки не показывает", () => {
    render(<SignInUnavailable service="practice" />);
    expect(screen.queryByText(/Заметки на этом устройстве/)).toBeNull();
  });

  it("C3: отказ объяснён, и рядом сказано, что можно", () => {
    render(<IdentityTaken />);
    expect(screen.getByText(/уже привязан к другому аккаунту СИМПАС/)).toBeVisible();
    expect(screen.getByText(/Войдите тем способом, которым пользовались раньше/)).toBeVisible();
  });
});

describe("поведение формы почты", () => {
  it("отправляет введённый адрес", async () => {
    const onSubmitEmail = vi.fn();
    render(<SignIn {...base} providers={[]} onSubmitEmail={onSubmitEmail} />);
    await userEvent.type(screen.getByLabelText("Электронная почта"), "t@ya.ru");
    await userEvent.click(screen.getByRole("button", { name: "Получить ссылку для входа" }));
    expect(onSubmitEmail).toHaveBeenCalledWith("t@ya.ru");
  });

  it("на явную опечатку отвечает подсказкой, а не молчанием", async () => {
    const onSubmitEmail = vi.fn();
    render(<SignIn {...base} providers={[]} onSubmitEmail={onSubmitEmail} />);
    await userEvent.type(screen.getByLabelText("Электронная почта"), "без-собаки");
    await userEvent.click(screen.getByRole("button", { name: "Получить ссылку для входа" }));
    expect(onSubmitEmail).not.toHaveBeenCalled();
    expect(screen.getByText("Проверьте адрес: похоже, в нём опечатка.")).toBeVisible();
  });
});

afterEach(() => cleanup());

describe("юридическая строка совпадает со словарём дословно", () => {
  it("на экране ровно тот текст, что записан в словаре", () => {
    // Строка жила В ДВУХ местах: в серверной разметке и зашитой в этом
    // компоненте. Я поправил первую и решил, что дело сделано, — а
    // человек видит вторую: разметку заменяет скрипт. Проверка на
    // сервере при этом была зелёной.
    //
    // Теперь видимый текст сверяется со словарём целиком, и разъехаться
    // им незаметно уже нельзя.
    render(<SignIn {...base} />);
    const line = screen.getByTestId("legal-line");
    expect(line.textContent?.replace(/\s+/g, " ").trim())
      .toBe(`${signIn.legalAccept()} ${signIn.legalPrivacy}`);
  });

  it("номера редакции на экране нет", () => {
    render(<SignIn {...base} />);
    expect(document.body.textContent).not.toMatch(/редакция/i);
  });

  it("ссылки ведут на конкретную редакцию", () => {
    // Убрана надпись, не доказательство.
    render(<SignIn {...base} />);
    const links = screen.getByTestId("legal-line").querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href")))
      .toEqual(["/legal/terms/0.9", "/legal/privacy/0.9"]);
  });
});

describe("подсказка провайдера выделяет кружок, а не прячет остальные", () => {
  /**
   * Продукт назвал, какой кружок нажал человек на своём экране. Наш
   * экран обязан привести его туда, куда кружок обещал, — и при этом
   * остаться экраном входа: юридическая строка на нём, и вход по
   * подтверждённой почте доступен всегда (И-5).
   */
  it("названный провайдер стоит первым", () => {
    render(<SignIn service="practice" providers={["yandex", "vkid"]}
      focusProvider="vkid" termsVersion="0.9" />);
    const discs = [...document.querySelectorAll("[data-provider]")]
      .map((b) => b.getAttribute("data-provider"));
    expect(discs).toEqual(["vkid", "yandex"]);
  });

  it("названный провайдер помечен, остальные — нет", () => {
    render(<SignIn service="practice" providers={["yandex", "vkid"]}
      focusProvider="vkid" termsVersion="0.9" />);
    expect(document.querySelector('[data-provider="vkid"]')).toHaveAttribute("data-focus", "true");
    expect(document.querySelector('[data-provider="yandex"]')).not.toHaveAttribute("data-focus");
  });

  it("вход по почте остаётся на экране", () => {
    render(<SignIn service="practice" providers={["yandex", "vkid"]}
      focusProvider="vkid" termsVersion="0.9" />);
    expect(screen.getByLabelText(/почт/i)).toBeVisible();
  });

  it("юридическая строка на месте", () => {
    render(<SignIn service="practice" providers={["yandex", "vkid"]}
      focusProvider="vkid" termsVersion="0.9" />);
    expect(screen.getByTestId("legal-line")).toBeVisible();
  });

  it("без подсказки порядок прежний", () => {
    render(<SignIn service="practice" providers={["yandex", "vkid"]} termsVersion="0.9" />);
    const discs = [...document.querySelectorAll("[data-provider]")]
      .map((b) => b.getAttribute("data-provider"));
    expect(discs).toEqual(["yandex", "vkid"]);
  });
});
