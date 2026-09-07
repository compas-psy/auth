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
  "for k in SIMPASID_DB_PASSWORD YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET MAIL_TOKEN; do",
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

  it("встроенной правки .env через sed в рабочем процессе не осталось", () => {
    // Иначе логика разъедется с проверенной здесь, и проверка
    // перестанет что-либо доказывать.
    expect(script).not.toContain("sed -i");
    expect(script).not.toContain("openssl rand");
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

  it("из .env печатает только имена, но никогда значения", () => {
    // Значение YANDEX_CLIENT_SECRET в журнале прогона — это выданный
    // секрет. Имя ключа секретом не является и отвечает на нужный
    // вопрос: дошёл ли ключ до сервера.
    expect(script).not.toMatch(/\bcat\b[^\n]*\.env/);
    expect(script).toContain("cut -d= -f1");
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
