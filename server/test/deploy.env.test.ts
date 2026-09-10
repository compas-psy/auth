import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SCRIPT = fileURLToPath(new URL("../../deploy/prepare-env.sh", import.meta.url));

// Проба повторяет то, что делает docker compose: у него окружение
// оболочки СТАРШЕ .env, и переменная, установленная в пустое,
// перекрывает записанное в файле. Поэтому проверяем не только .env,
// но и то, что осталось в оболочке после скрипта.
const PROBE = [
  "set -eu",
  '. "$SCRIPT"',
  "for k in SIMPASID_DB_PASSWORD YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET MAIL_TOKEN VKID_CLIENT_ID; do",
  '  eval "marker=\\${$k+set}"',
  '  if [ -n "${marker:-}" ]; then',
  '    eval "printf \'SHELL_SET %s=%s\\n\' \\"$k\\" \\"\\$$k\\""',
  "  else",
  '    printf \'SHELL_UNSET %s\\n\' "$k"',
  "  fi",
  "done",
].join("\n");

type Run = {
  /** Содержимое .env после работы скрипта. */
  env: Record<string, string>;
  /** Что осталось в оболочке: имя → значение, только для установленных. */
  shell: Record<string, string>;
  /** Имена, убранные из оболочки. */
  unset: string[];
  mode: number;
};

function run(exported: Record<string, string>, seedEnvFile?: string): Run {
  const dir = mkdtempSync(join(tmpdir(), "simpasid-prepare-env-"));
  if (seedEnvFile !== undefined) writeFileSync(join(dir, ".env"), seedEnvFile, { mode: 0o600 });

  const out = execFileSync("sh", ["-c", PROBE], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SCRIPT, ...exported },
  });

  const shell: Record<string, string> = {};
  const unset: string[] = [];
  for (const line of out.split("\n")) {
    const set = /^SHELL_SET ([A-Z_]+)=(.*)$/.exec(line);
    if (set) shell[set[1]!] = set[2]!;
    const off = /^SHELL_UNSET ([A-Z_]+)$/.exec(line);
    if (off) unset.push(off[1]!);
  }

  const env: Record<string, string> = {};
  const raw = readFileSync(join(dir, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }

  return { env, shell, unset, mode: statSync(join(dir, ".env")).mode & 0o777 };
}

/**
 * Значение, которое в итоге увидит docker compose: оболочка старше
 * файла, и УСТАНОВЛЕННАЯ В ПУСТОЕ переменная тоже старше.
 */
function effective(r: Run, key: string): string {
  return key in r.shell ? r.shell[key]! : (r.env[key] ?? "");
}

describe("подготовка .env перед docker compose", () => {
  it("пустой секрет не перекрывает пароль, уже записанный в .env", () => {
    // Ровно этот случай уронил выкладку 605854e:
    // «required variable SIMPASID_DB_PASSWORD is missing a value»
    // при непустом .env — потому что ssh-action объявляет имя всегда,
    // даже когда секрета в репозитории нет.
    const r = run(
      { SIMPASID_DB_PASSWORD: "", YANDEX_CLIENT_ID: "", YANDEX_CLIENT_SECRET: "" },
      "SIMPASID_DB_PASSWORD=уже-живущий-пароль\n",
    );
    expect(r.env.SIMPASID_DB_PASSWORD).toBe("уже-живущий-пароль");
    expect(effective(r, "SIMPASID_DB_PASSWORD")).toBe("уже-живущий-пароль");
  });

  it("ни одно имя не остаётся в оболочке установленным в пустое", () => {
    const r = run({
      SIMPASID_DB_PASSWORD: "", YANDEX_CLIENT_ID: "", YANDEX_CLIENT_SECRET: "", MAIL_TOKEN: "",
    });
    expect(Object.entries(r.shell).filter(([, v]) => v === "")).toEqual([]);
  });

  it("пароль заводится сам, когда его нет ни в секретах, ни в файле", () => {
    const r = run({ SIMPASID_DB_PASSWORD: "" });
    expect(effective(r, "SIMPASID_DB_PASSWORD").length).toBeGreaterThanOrEqual(24);
  });

  it("переданный пароль записывается и им же остаётся действующим", () => {
    const r = run({ SIMPASID_DB_PASSWORD: "заданный-человеком" });
    expect(r.env.SIMPASID_DB_PASSWORD).toBe("заданный-человеком");
    expect(effective(r, "SIMPASID_DB_PASSWORD")).toBe("заданный-человеком");
  });

  it("пустой ключ провайдера не затирает уже записанный", () => {
    const r = run(
      { YANDEX_CLIENT_ID: "", YANDEX_CLIENT_SECRET: "" },
      "SIMPASID_DB_PASSWORD=p\nYANDEX_CLIENT_ID=прежний\n",
    );
    expect(effective(r, "YANDEX_CLIENT_ID")).toBe("прежний");
  });

  it("секрет со спецсимволами записывается дословно", () => {
    // Прежняя запись через sed "s|^KEY=.*|KEY=$value|" ломалась на
    // '|', '&' и обратной косой: секрет провайдера их допускает.
    const secret = "a|b&c\\d/e.f";
    const r = run({ YANDEX_CLIENT_SECRET: secret }, "YANDEX_CLIENT_SECRET=старый\n");
    expect(effective(r, "YANDEX_CLIENT_SECRET")).toBe(secret);
  });

  it("повторный прогон не плодит дублей строк", () => {
    const dir = mkdtempSync(join(tmpdir(), "simpasid-prepare-twice-"));
    for (let i = 0; i < 3; i += 1) {
      execFileSync("sh", ["-c", 'set -eu; . "$SCRIPT"'], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SCRIPT, YANDEX_CLIENT_ID: "x" },
      });
    }
    const lines = readFileSync(join(dir, ".env"), "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => l.startsWith("SIMPASID_DB_PASSWORD=")).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("YANDEX_CLIENT_ID=")).length).toBe(1);
  });

  it("пароль не меняется от прогона к прогону", () => {
    // Смена пароля на живой базе отрезала бы приложение от неё.
    const dir = mkdtempSync(join(tmpdir(), "simpasid-prepare-stable-"));
    const read = () => readFileSync(join(dir, ".env"), "utf8");
    const opts = { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SCRIPT } };
    execFileSync("sh", ["-c", 'set -eu; . "$SCRIPT"'], opts);
    const first = read();
    execFileSync("sh", ["-c", 'set -eu; . "$SCRIPT"'], opts);
    expect(read()).toBe(first);
  });

  it("файл закрыт от посторонних", () => {
    expect(run({}).mode).toBe(0o600);
  });
});

describe("рабочий процесс выкладки", () => {
  const wf = parse(
    readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, { steps: { uses?: string; run?: string; with?: { script?: string } }[] }> };

  const script = wf.jobs.deploy!.steps.find((s) => s.uses?.startsWith("appleboy/ssh-action"))!
    .with!.script!;

  it("подключает общий скрипт, а не повторяет его встроенной копией", () => {
    expect(script).toContain(". ./deploy/prepare-env.sh");
  });

  it("подключение идёт до запуска compose", () => {
    // Ищем именно команду, а не слова «docker compose» в пояснении.
    expect(script.indexOf(". ./deploy/prepare-env.sh"))
      .toBeLessThan(script.indexOf("docker compose --project-name simpasid up"));
  });

  it("проверяет живой адрес, а не только код возврата ssh", () => {
    // «Команда выполнена» и «сервис отвечает по своему адресу» — не
    // одно и то же. Между ними стоит nginx, TLS и перенаправление,
    // и именно там auth.cmpas.ru некоторое время проксировал на
    // чужой сервис, пока команды выполнялись успешно.
    const steps = wf.jobs.deploy!.steps.map((st) => st.run ?? "").join("\n");
    expect(steps).toContain("https://auth.cmpas.ru/.well-known/openid-configuration");
    expect(steps).toContain("Strict-Transport-Security");
    expect(steps).toContain("https://cmpas.ru/");
  });

  it("живая проверка убеждается, что первичный токен-API закрыт", () => {
    // /v1/auth/* доступен ТОЛЬКО клиентам с first_party = true
    // (12_NATIVE_AUTH.md §3.1). Проверка ждёт именно 403
    // forbidden_client: открытый ответ означал бы, что вход,
    // спроектированный в расчёте на доверенное приложение, отдан
    // всем желающим. Состав способов входа анонимно не смотрится —
    // и не должен.
    const steps = wf.jobs.deploy!.steps.map((st) => st.run ?? "").join("\n");
    expect(steps).toContain("/v1/auth/methods");
    expect(steps).toContain("forbidden_client");
  });

  it("живая проверка доходит до самого экрана входа", () => {
    // Discovery и /healthz отвечают и тогда, когда войти нельзя: ровно
    // так и было, пока не обрабатывался шаг разрешения. Дверь проверяется
    // тем, что её открывают, а не тем, что она числится в описи.
    const steps = wf.jobs.deploy!.steps.map((st) => st.run ?? "").join("\n");
    expect(steps).toContain("/oidc/auth?");
    expect(steps).toContain("code_challenge_method=S256");
  });

  it("состав способов входа читается из состояния страницы, а не из разметки", () => {
    // Кнопки провайдеров рисует скрипт на клиенте; в серверной
    // разметке их нет. Проверка, ищущая «Яндекс» в HTML, не найдёт его
    // никогда — и «нет внешних способов» будет означать лишь то, что
    // смотрели не туда. Состав лежит в JSON-состоянии страницы, оттуда
    // же его читает тест связки (provider.wiring.test.ts).
    const steps = wf.jobs.deploy!.steps.map((st) => st.run ?? "").join("\n");
    expect(steps).toContain('id="state"');
  });

  it("живая проверка ищет текст И в разметке, И в собранном скрипте", () => {
    // Юридическая строка живёт в двух местах: серверная разметка и
    // компонент портала. Проверка только разметки уже один раз
    // подтвердила правку в месте, которого человек не видит, — экран
    // рисует скрипт. Смотреть надо оба.
    const steps = wf.jobs.deploy!.steps.map((st) => st.run ?? "").join("\n");
    expect(steps).toContain("/assets/portal.js");
    expect(steps).toContain("редакция");
  });

  it("встроенной правки .env через sed в рабочем процессе не осталось", () => {
    // Иначе логика разъедется с проверенной здесь, и проверка
    // перестанет что-либо доказывать.
    expect(script).not.toContain("sed -i");
    expect(script).not.toContain("openssl rand");
  });
});

describe("проба входа", () => {
  const raw = readFileSync(
    new URL("../../.github/workflows/probe.yml", import.meta.url), "utf8");
  const wf = parse(raw) as {
    on: Record<string, unknown>;
    jobs: Record<string, { steps: { run?: string; with?: { script?: string } }[] }>;
  };
  const run = wf.jobs.probe!.steps[0]!.run!;

  it("ходит сама, а не только руками", () => {
    // Смысл пробы в том, чтобы узнать о падении раньше человека.
    expect(Object.keys(wf.on)).toContain("schedule");
  });

  it("проверяет дверь, а не признаки жизни", () => {
    // /healthz отвечает и тогда, когда войти нельзя: ровно так и было,
    // пока не обрабатывался шаг разрешения.
    expect(run).toContain("/oidc/auth?");
    expect(run).toContain("Вход в");
  });

  it("замечает экран «временно недоступен»", () => {
    // Он отдаётся с кодом 200 при Accept: text/html, поэтому проверка
    // «страница вернулась» его бы не поймала. Учредитель поймал руками.
    expect(run).toContain("временно недоступен");
  });

  it("ходит снаружи и без доступа к серверу", () => {
    // Проба повторяет путь браузера. Ключей у неё нет: проба, которой
    // дали доступ к серверу, — ещё одна дверь в бой.
    expect(raw).not.toContain("ssh-action");
    expect(raw).not.toContain("SSH_PRIVATE_KEY");
    expect(raw).not.toContain("docker");
  });

  it("не заводит по задаче на каждую неудачу", () => {
    // Сорок задач за десять часов — это не оповещение, а шум, в
    // котором тонет и настоящее.
    const notify = wf.jobs.probe!.steps[1]!.with!.script!;
    expect(notify).toContain("listForRepo");
    expect(notify).toContain("createComment");
  });
});

describe("осмотр сервера", () => {
  const raw = readFileSync(
    new URL("../../.github/workflows/diagnose.yml", import.meta.url), "utf8");
  const wf = parse(raw) as {
    on: Record<string, unknown>;
    jobs: Record<string, { steps: { with?: { script?: string } }[] }>;
  };
  const script = wf.jobs.ports!.steps[0]!.with!.script!;

  it("запускается только руками", () => {
    // Осмотр, который ходит на боевой сервер сам по расписанию или на
    // каждый push, — лишний доступ без повода.
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
  });

  it("не содержит ни одной команды, меняющей состояние", () => {
    // Смысл осмотра — узнать, а не поправить. Соседний продукт живой.
    const forbidden = [
      "docker compose", "docker run", "docker stop", "docker rm", "docker kill",
      "systemctl", "kill ", "rm ", "mv ", "sed -i", "tee ", ">>", "chmod", "chown",
    ];
    for (const cmd of forbidden) {
      expect({ cmd, found: script.includes(cmd) }).toEqual({ cmd, found: false });
    }
  });

  it("показывает применённые миграции и запрет на смену sub", () => {
    // Раньше применённость миграции на боевом сервере ВЫВОДИЛАСЬ из
    // устройства запуска, а не наблюдалась. Вывод был верным, но
    // обязательство перед продуктом лучше видеть.
    expect(script).toContain("dist/cli/schema.js");
    expect(script).toContain("состояние схемы");
  });

  it("осмотр схемы остаётся чтением", () => {
    // Оболочка вызывает отдельную команду; она обязана быть той,
    // которая только спрашивает.
    const cli = readFileSync(
      new URL("../src/cli/schema.ts", import.meta.url), "utf8");
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"]) {
      expect({ forbidden, found: cli.includes(forbidden) })
        .toEqual({ forbidden, found: false });
    }
  });

  it("из .env печатает только имена, но никогда значения", () => {
    // Значение YANDEX_CLIENT_SECRET в журнале прогона — это выданный
    // секрет. Имя ключа секретом не является и отвечает на нужный
    // вопрос: дошёл ли ключ до сервера.
    expect(script).not.toMatch(/\bcat\b[^\n]*\.env/);
    expect(script).toContain("cut -d= -f1");
  });

  it("спрашивает про пределы sshd и fail2ban", () => {
    // Д-3: рукопожатие рвётся до единой команды. Догадку («MaxStartups
    // сбрасывает лишние подключения») нельзя оставлять догадкой —
    // осмотр обязан её проверять, иначе долг закроют словами.
    expect(script).toContain("maxstartups");
    expect(script).toContain("drop connection");
    expect(script).toContain("fail2ban-client");
  });

  it("про SSH печатает причины, но не чужие адреса", () => {
    // В журнале sshd адресов больше, чем где-либо ещё на сервере, и
    // почти все они чужие. Журнал прогона видит тот же круг, что и
    // секреты, но это не повод складывать туда чужое.
    // Обе команды, у которых адреса в выводе, обязаны идти через
    // фильтр. Проверяется склейкой переносов: без неё «| grep» на
    // следующей строке выглядит как отдельная команда.
    const joined = script.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      if (line.includes("fail2ban-client status sshd")) {
        expect({ line, filtered: line.includes("| grep") }).toEqual({ line, filtered: true });
      }
      if (line.includes("journalctl -u ssh")) {
        expect({ line, filtered: line.includes("| grep -oE") }).toEqual({ line, filtered: true });
      }
    }
    // Список забаненных адресов не печатается ни при каких условиях.
    expect(script).not.toContain("Banned IP list");
  });

  it("не печатает полные командные строки чужих процессов", () => {
    // В аргументах соседского процесса может оказаться то, чему не
    // место в журнале прогона.
    expect(script).not.toMatch(/\bps\s+(aux|-ef)/);
  });
});

describe("обустройство прокси и TLS", () => {
  const wf = parse(
    readFileSync(new URL("../../.github/workflows/provision.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, { steps: { uses?: string; with?: { script?: string } }[] }> };
  const script = wf.jobs.provision!.steps.find((st) => st.uses?.startsWith("appleboy/ssh-action"))!
    .with!.script!;

  it("возвращает TLS после того, как перезаписал конфигурацию", () => {
    // Ловушка: install перезаписывает файл нашей версией, а блок
    // listen 443 в него дописал certbot при первом выпуске. Условие
    // «сертификат уже есть» пропускало certbot — и сервис
    // идентичности тихо съезжал на HTTP, где Secure-cookie не живёт.
    // certbot install переустанавливает уже выпущенный сертификат,
    // ничего не перевыпуская.
    expect(script).toContain("certbot install");
    expect(script).toContain("--cert-name auth.cmpas.ru");
  });

  it("наличие TLS определяется директивой, а не упоминанием", () => {
    // Проверка grep -q "listen 443" находила КОММЕНТАРИЙ в нашем же
    // файле («certbot сам добавит listen 443») и потому всегда
    // считала, что TLS настроен. Certbot не вызывался ни разу, шаг
    // отчитывался успехом за три секунды, а сервис стоял без HTTPS.
    // Здесь берётся ТОТ ЖЕ образец, что и в рабочем процессе, и
    // прикладывается к нашему файлу, где директивы нет, а
    // комментарий есть.
    const m = /TLS_RE='([^']+)'/.exec(script);
    expect(m).not.toBeNull();
    const conf = fileURLToPath(new URL("../../deploy/proxy/auth.cmpas.ru.conf", import.meta.url));
    expect(readFileSync(conf, "utf8")).toContain("listen 443");
    const found = spawnSync("grep", ["-Eq", m![1]!, conf]).status;
    expect({ образец: m![1]!, нашёл: found === 0 }).toEqual({ образец: m![1]!, нашёл: false });
  });

  it("итог подтверждается запросом, а не чтением файла", () => {
    // Файл — это намерение. Отвечает ли сервис по HTTPS, показывает
    // только запрос.
    expect(script).toContain("https://auth.cmpas.ru/healthz");
  });

  it("падает, если TLS так и не встал", () => {
    const tail = script.slice(script.lastIndexOf("listen 443"));
    expect(tail).toContain("exit 1");
  });

  it("перезагружает nginx только после успешной проверки конфигурации", () => {
    for (const m of script.matchAll(/systemctl reload nginx/g)) {
      const before = script.slice(0, m.index);
      expect(before).toContain("nginx -t");
    }
  });
});

/**
 * Ключ VK ID доезжает до сервера тем же путём, что и ключи Яндекса.
 *
 * Путь длинный: секрет репозитория → окружение действия → envs →
 * prepare-env.sh → .env → docker compose → контейнер. Пропуск любого
 * звена даёт не отказ, а ТИШИНУ: провайдер просто не подключается, и
 * кнопки VK на экране не появляется. Разбираться в этом на живом
 * сервере дороже, чем проверить здесь.
 */
describe("ключ VK ID доезжает до контейнера", () => {
  it("prepare-env.sh знает про VKID_CLIENT_ID", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain("VKID_CLIENT_ID");
  });

  it("выкладка передаёт его на сервер", () => {
    const wf = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/deploy.yml", import.meta.url)), "utf8");
    expect(wf).toContain("VKID_CLIENT_ID: ${{ secrets.VKID_CLIENT_ID }}");
    // envs — перечень имён, которые действие вообще пронесёт в скрипт.
    expect(/envs:.*VKID_CLIENT_ID/.test(wf)).toBe(true);
  });

  it("compose отдаёт его приложению", () => {
    const compose = readFileSync(
      fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)), "utf8");
    expect(compose).toContain("VKID_CLIENT_ID: ${VKID_CLIENT_ID:-}");
  });

  it("секрет приложения VK на сервер не едет: он там не нужен", () => {
    // Обмен кода у VK идёт без client_secret — защита на PKCE и
    // зарегистрированном адресе возврата. Лишний секрет на сервере —
    // это то, что можно потерять, ничего не приобретя.
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).not.toContain("VKID_CLIENT_SECRET");
  });
});
