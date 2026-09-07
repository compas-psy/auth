import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
  ) as { jobs: Record<string, { steps: { uses?: string; with?: { script?: string } }[] }> };

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

  it("не печатает полные командные строки чужих процессов", () => {
    // В аргументах соседского процесса может оказаться то, чему не
    // место в журнале прогона.
    expect(script).not.toMatch(/\bps\s+(aux|-ef)/);
  });
});
