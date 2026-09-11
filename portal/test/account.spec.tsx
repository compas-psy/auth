import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Account } from "../src/screens/Account";
import { Personal } from "../src/screens/Personal";
import { Security } from "../src/screens/Security";
import { Devices } from "../src/screens/Devices";
import { Communications } from "../src/screens/Communications";
import { Privacy } from "../src/screens/Privacy";
import { API_CALLS } from "../src/api/client";

afterEach(() => cleanup());

const spec = parse(readFileSync("../server/openapi/simpasid.v1.yaml", "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Все обращения к API, встречающиеся в исходниках портала. */
function collectApiCalls(dir: string): string[] {
  const found = new Set<string>();
  for (const file of walk(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/["'`](\/v1\/[^"'`$]*)["'`]/g)) {
      found.add(m[1]!);
    }
  }
  return [...found];
}

/** Приводит путь с подстановкой к виду спецификации: /account/emails/{id}. */
function toSpecPath(call: string): string {
  return call.replace(/^\/v1/, "");
}

describe("портал аккаунта: внутреннего пути не существует", () => {
  it("не содержит ни одного вызова, которого нет в спецификации", () => {
    const declared = new Set(Object.keys(spec.paths));
    const undeclared: string[] = [];
    for (const call of collectApiCalls("src")) {
      const path = toSpecPath(call);
      const matches = [...declared].some((d) =>
        // Объявленный путь с параметром сопоставляется по форме:
        // /account/emails/{email_id} принимает /account/emails/:id.
        new RegExp(`^${d.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
      if (!matches) undeclared.push(call);
    }
    expect(undeclared).toEqual([]);
  });

  it("перечень вызовов клиента объявлен явно и весь есть в спецификации", () => {
    const declared = new Set(Object.keys(spec.paths));
    for (const call of API_CALLS) {
      const matches = [...declared].some((d) =>
        new RegExp(`^${d.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(call));
      expect({ call, matches }).toEqual({ call, matches: true });
    }
  });

  it("весь портал ходит через один клиент, и его основание — /v1", () => {
    // Отдельная ручка «для своих» — это и есть внутренний путь. Ловится
    // не перечислением адресов, а тем, что место обращения к сети
    // ровно одно: второй fetch где-нибудь в экране пройдёт мимо любой
    // проверки путей, а мимо этой не пройдёт.
    const callSites = new Set<string>();
    for (const file of walk("src")) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const _ of text.matchAll(/\bfetch\s*\(/g)) callSites.add(file);
    }
    // Ровно три места, и все три названы. Четвёртый fetch где-нибудь в
    // экране прошёл бы мимо любой проверки путей, а мимо этой не
    // пройдёт.
    //   api/client.ts  — API аккаунта, только /v1;
    //   App.tsx        — вход, только /interaction/ (контур OIDC, а не
    //                    API аккаунта: в спецификации v1 его нет по
    //                    существу, а не по недосмотру);
    //   auth/oidc.ts   — обмен кода на ключ доступа, только /oidc/token.
    expect([...callSites].sort())
      .toEqual(["src/App.tsx", "src/api/client.ts", "src/auth/oidc.ts"]);

    // Вход портала ходит ровно в одну ручку протокола и никуда больше.
    const auth = readFileSync("src/auth/oidc.ts", "utf8");
    for (const m of auth.matchAll(/fetch\(\s*[`"']([^`"']+)/g)) {
      expect(m[1]).toBe("/oidc/token");
    }
    // Ключ доступа не сохраняется: строка хранилища с ключом входа
    // переживает вкладку и достаётся любому скрипту на этом домене.
    expect(auth).not.toContain("localStorage");

    const client = readFileSync("src/api/client.ts", "utf8");
    expect(client).toMatch(/const BASE = "\/v1";/);
    expect(client).toMatch(/fetch\(`\$\{BASE\}\$\{path\}`/);

    // Экран входа не имеет права ходить в API аккаунта в обход клиента.
    const app = readFileSync("src/App.tsx", "utf8");
    for (const m of app.matchAll(/fetch\(\s*[`"']([^`"']+)/g)) {
      expect(m[1]!.startsWith("/interaction/")).toBe(true);
    }
  });
});

const profile = {
  id: "acc_1", email: "t…v@ya.ru", email_verified: true,
  display_name: "Илья", products: ["practice" as const],
};

describe("портал аккаунта: правила экранов", () => {
  it("строка про пароль хранилища — без органов управления", () => {
    render(<Security profile={profile} identities={[]} productsMigrated={["practice"]}
      returnTo="practice" />);
    const row = screen.getByTestId("vault-note");
    expect(row.textContent).toContain("к аккаунту не относится");
    expect(row.querySelector("button")).toBeNull();
    expect(row.querySelector("input")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
  });

  it("переходное состояние ЗАПИСОК показывается, пока продукт не переехал", () => {
    render(<Security profile={profile} identities={[]} productsMigrated={["practice"]}
      returnTo="practice" />);
    expect(screen.getByText(/ЗАПИСКИ пока входят отдельно/)).toBeVisible();
  });

  it("после переезда ЗАПИСОК переходной строки нет", () => {
    render(<Security profile={profile} identities={[]}
      productsMigrated={["practice", "zapiski"]} returnTo="practice" />);
    expect(screen.queryByText(/ЗАПИСКИ пока входят отдельно/)).toBeNull();
  });

  it("почта названа основным способом, который нельзя удалить", () => {
    render(<Security profile={profile} identities={[]} productsMigrated={["practice"]}
      returnTo="practice" />);
    expect(screen.getByText("Основной способ. Удалить нельзя.")).toBeVisible();
  });

  it("«ключ доступа», а не «passkey», и с пояснением", () => {
    render(<Security profile={profile} identities={[]} productsMigrated={["practice"]}
      returnTo="practice" />);
    expect(screen.getByText("Ключ доступа")).toBeVisible();
    expect(screen.getByText("Вход отпечатком или лицом, без письма.")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/passkey/i);
  });

  it("на каждом экране есть путь возврата в продукт", () => {
    const screens = [
      <Account key="a" profile={profile} products={[]} returnTo="practice" />,
      <Personal key="p" profile={profile} emails={[]} returnTo="practice" />,
      <Security key="s" profile={profile} identities={[]} productsMigrated={[]} returnTo="practice" />,
      <Devices key="d" sessions={[]} returnTo="practice" />,
      <Communications key="c" communications={[]} termsVersion="0.9" returnTo="practice" />,
      <Privacy key="v" documents={[]} returnTo="practice" />,
    ];
    for (const s of screens) {
      render(s);
      expect(screen.getByRole("link", { name: /Вернуться в ПРАКТИКУ/ })).toBeVisible();
      cleanup();
    }
  });
});

describe("J1 — обзор", () => {
  it("перечень продуктов приходит из данных, а не из вёрстки", () => {
    render(<Account profile={profile} returnTo="practice"
      products={[{ code: "practice", since: "12 марта 2026" }]} />);
    expect(screen.getByText("ПРАКТИКА")).toBeVisible();
    // «Не подключены» пишется явно — то же правило, что тест Т11.
    expect(screen.getAllByText("не подключены").length).toBeGreaterThan(0);
  });
});

describe("L2 — устройства и сеансы", () => {
  it("показывает огрублённые платформу и клиента", () => {
    render(<Devices returnTo="practice" sessions={[
      { id: "s1", current: true, platform: "windows", client: "chrome",
        last_seen_at: "2026-09-06T14:20:00Z" },
      { id: "s2", current: false, platform: "android", client: "app",
        last_seen_at: "2026-09-03T09:12:00Z" },
    ]} />);
    expect(screen.getByText(/Windows · Chrome/)).toBeVisible();
    expect(screen.getByText(/Android · приложение/)).toBeVisible();
  });

  it("строка про IP-адрес обязательна", () => {
    render(<Devices returnTo="practice" sessions={[]} />);
    expect(screen.getByText(
      "Мы не храним ваш IP-адрес и точное устройство — только то, что видно выше."
    )).toBeVisible();
  });

  it("у текущего сеанса нет кнопки «Завершить»", () => {
    render(<Devices returnTo="practice" sessions={[
      { id: "s1", current: true, platform: "windows", client: "chrome",
        last_seen_at: "2026-09-06T14:20:00Z" },
    ]} />);
    expect(screen.queryByRole("button", { name: "Завершить" })).toBeNull();
  });
});

describe("M1 и M3 — коммуникации", () => {
  const off = [
    { channel: "email" as const, status: "revoked" as const, since: null },
    { channel: "push" as const, status: "revoked" as const, since: null },
  ];

  it("все переключатели выключены — единственное исходное состояние", () => {
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice" />);
    for (const s of screen.getAllByRole("switch")) {
      expect(s).toHaveAttribute("aria-checked", "false");
    }
  });

  it("разделение сервисных и рекламных сообщений сказано прямым текстом", () => {
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice" />);
    expect(screen.getByText(/Письма о записи, оплате, входе и безопасности приходят всегда/))
      .toBeVisible();
  });

  it("«Отключить всю рекламу» присутствует всегда", () => {
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice" />);
    expect(screen.getByRole("button", { name: "Отключить всю рекламу" })).toBeVisible();
  });

  it("номер редакции на экране не называется", () => {
    // Решение учредителя 07.09.2026: номера редакций с экранов убраны.
    // В макете их и не было — они были дописаны в реализации.
    // Что именно принято, доказывается записью в журнале согласий и
    // ссылкой на неизменяемый адрес редакции, а не надписью.
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice" />);
    expect(document.body.textContent).not.toMatch(/редакция/i);
  });

  it("SMS и звонков среди каналов нет", () => {
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice" />);
    expect(document.body.textContent).not.toMatch(/SMS|звонк/i);
  });

  it("подтверждение отключения объясняет, что продолжит приходить", async () => {
    const onRevokeAll = vi.fn();
    render(<Communications communications={off} termsVersion="0.9" returnTo="practice"
      onRevokeAll={onRevokeAll} />);
    await userEvent.click(screen.getByRole("button", { name: "Отключить всю рекламу" }));
    expect(screen.getByText("Письма о записи, оплате и безопасности продолжат приходить."))
      .toBeVisible();
  });
});

describe("N1 — данные и приватность", () => {
  it("реестры и Политика открываются с нашего домена, а не из продукта", () => {
    // Д-1 из 13_LEGAL_CONSENT_CENTER_AUTH.md: центральные документы
    // Экосистемы жили на cmpas.ru. Ссылка на домен продукта здесь —
    // возврат к тому же дефекту, поэтому проверяется адрес, а не
    // наличие ссылки.
    render(<Privacy returnTo="practice" documents={[]} />);
    const hrefs = screen.getAllByRole("link", { name: "Открыть" })
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/legal/privacy", "/legal/services", "/legal/processors"]);
  });

  it("про Политику прямо сказано, что её не принимают", () => {
    render(<Privacy returnTo="practice" documents={[]} />);
    expect(screen.getByText(/Принимать его не нужно/)).toBeVisible();
  });

  it("ссылка ведёт на ПРИНЯТУЮ редакцию, а не на текущую", () => {
    // Номер редакции с экрана убран, но человек обязан иметь
    // возможность посмотреть именно ту редакцию, которую принял, —
    // даже когда действует уже следующая. Это и есть доказательство,
    // а не надпись.
    render(<Privacy returnTo="practice" documents={[
      { document_code: "cmpas_terms", title: "Пользовательское соглашение СИМПАС",
        version: "0.9", accepted_at: "2026-03-12T09:00:00Z", url: "/legal/terms/0.9" },
    ]} />);
    const link = screen.getByRole("link", { name: "Посмотреть текст" });
    expect(link).toHaveAttribute("href", "/legal/terms/0.9");
    expect(screen.getByText("Пользовательское соглашение СИМПАС")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/редакция/i);
  });

  it("портал не дублирует «Мои данные», а ведёт на него", () => {
    render(<Privacy returnTo="practice" documents={[]} />);
    expect(screen.getByRole("link", { name: "Мои данные" })).toBeVisible();
  });
});

describe("портал: запрещённые слова", () => {
  it("ни одного технического слова на экранах аккаунта", () => {
    const forbidden = ["OAuth", "OIDC", "SimpasID", "провайдер идентичности", "ПДн", "subject"];
    render(<Account profile={profile} products={[]} returnTo="practice" />);
    render(<Security profile={profile} identities={[]} productsMigrated={[]} returnTo="practice" />);
    render(<Devices sessions={[]} returnTo="practice" />);
    const text = (document.body.textContent ?? "").toLowerCase();
    for (const w of forbidden) expect(text).not.toContain(w.toLowerCase());
  });
});
