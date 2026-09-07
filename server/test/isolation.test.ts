import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

const compose = parse(
  readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
) as {
  name?: string;
  services: Record<string, {
    ports?: string[];
    volumes?: string[];
    networks?: string[];
    mem_limit?: string;
    restart?: string;
    environment?: Record<string, string>;
  }>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
};

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

/** Имена, принадлежащие соседям. Ни одно не должно встретиться. */
const NEIGHBOURS = [
  "cmpas-app", "cmpas-postgres", "cmpas-mailer", "cmpas_db", "cmpas-singbox",
  "db_data", "uploaded_files", "mail_queue", "/var/www/cmpas.ru", "zapiski",
];

describe("Р-1: изоляция от соседа", () => {
  it("у проекта Compose своё имя", () => {
    // Без своего name проект зовётся по имени каталога, и две выкладки
    // на одном сервере начинают спорить за одни и те же контейнеры.
    expect(compose.name).toBe("simpasid");
  });

  it("в compose нет ни одной ссылки на базу, тома или контейнеры ПРАКТИКИ", () => {
    const dump = JSON.stringify(compose);
    for (const name of NEIGHBOURS) {
      expect({ name, found: dump.includes(name) }).toEqual({ name, found: false });
    }
  });

  it("база не публикует порт наружу вовсе", () => {
    expect(compose.services.postgres!.ports).toBeUndefined();
  });

  it("приложение слушает только петлю, а не все адреса", () => {
    // Публикация 0.0.0.0:3100 выставила бы сервис мимо nginx и мимо TLS.
    for (const p of compose.services.app!.ports ?? []) {
      expect({ port: p, loopback: p.startsWith("127.0.0.1:") })
        .toEqual({ port: p, loopback: true });
    }
  });

  it("у каждой службы задан лимит памяти", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      expect({ name, limit: Boolean(svc.mem_limit) }).toEqual({ name, limit: true });
    }
  });

  it("тома объявлены свои и с именами, не пересекающимися с соседскими", () => {
    expect(Object.keys(compose.volumes ?? {}).sort()).toEqual(["simpasid_db", "simpasid_keys"]);
  });

  it("общая сеть с соседом не объявлена", () => {
    expect(compose.networks).toBeUndefined();
    for (const svc of Object.values(compose.services)) {
      expect(svc.networks).toBeUndefined();
    }
  });

  it("службы перезапускаются сами, но не жёстко", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      expect({ name, restart: svc.restart }).toEqual({ name, restart: "unless-stopped" });
    }
  });

  it("пароль базы не вписан в compose", () => {
    const dump = JSON.stringify(compose);
    expect(dump).toContain("${SIMPASID_DB_PASSWORD");
    expect(dump).not.toMatch(/POSTGRES_PASSWORD:\s*["']?[A-Za-z0-9]{8,}/);
  });
});

describe("образ", () => {
  it("работает не от root", () => {
    expect(dockerfile).toMatch(/^USER simpas$/m);
  });

  it("многоступенчатый: сборочные зависимости в образ не едут", () => {
    expect(dockerfile).toMatch(/FROM node:22-alpine AS deps/);
    expect(dockerfile).toContain("npm ci --omit=dev");
  });

  it("есть проверка здоровья", () => {
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/healthz");
  });

  it("ключи подписи лежат в томе, а не в образе", () => {
    expect(dockerfile).toContain('VOLUME ["/var/lib/simpasid"]');
    expect(dockerfile).not.toMatch(/COPY[^\n]*jwks/);
  });

  it("исходники спецификации едут в образ: справочник строится из них", () => {
    expect(dockerfile).toContain("server/openapi ./openapi");
  });

  it("сборочная стадия получает всё, что нужно npm run build", () => {
    // Стадия копирует только названное. Скрипт переноса миграций
    // подключён к build, но server/scripts в образ не копировался —
    // и сборка падала на Cannot find module copy-migrations.mjs.
    // Локально этого не видно: там лежит всё дерево.
    const stage = dockerfile.slice(
      dockerfile.indexOf("AS server-build"),
      dockerfile.indexOf("RUN npm run build"),
    );
    expect(stage).toContain("server/scripts ./scripts");
  });
});

describe("конфигурация прокси", () => {
  const conf = readFileSync(
    new URL("../../deploy/proxy/auth.cmpas.ru.conf", import.meta.url), "utf8");

  it("отвечает только на свой server_name", () => {
    const names = [...conf.matchAll(/server_name\s+([^;]+);/g)]
      .flatMap((m) => m[1]!.trim().split(/\s+/));
    // Ровно один домен, и он наш. Голый cmpas.ru здесь перехватывал бы
    // запросы соседа — это и есть то, чего нельзя делать.
    expect(names).toEqual(["auth.cmpas.ru"]);
  });

  it("передаёт X-Forwarded-Proto: без него не встанет Secure-cookie", () => {
    expect(conf).toContain("X-Forwarded-Proto");
  });

  it("объявляет HSTS", () => {
    expect(conf).toContain("Strict-Transport-Security");
  });

  it("ограничивает размер тела", () => {
    expect(conf).toMatch(/client_max_body_size\s+64k;/);
  });

  it("проксирует на петлю, а не наружу", () => {
    // Конкретный номер здесь не зашивается: он выводится из
    // docker-compose.yml проверкой «порт на петле» ниже. Два места с
    // одним числом однажды разъедутся, и разъезд будет тихим.
    for (const t of conf.matchAll(/proxy_pass\s+http:\/\/([^;\/]+)/g)) {
      expect(t[1]).toMatch(/^127\.0\.0\.1:\d+$/);
    }
  });
});

/**
 * Порты соседей на петле этого сервера. Список снят осмотром
 * (рабочий процесс «Осмотр сервера», прогон 34108490636), а не
 * предположен: 3000 — cmpas-app (ПРАКТИКА), 3100 — zapiski-api
 * (ЗАПИСКИ), 3306 — mysqld, 1080 — cmpas-singbox.
 */
const NEIGHBOUR_PORTS = [25, 80, 443, 1080, 3000, 3100, 3306, 33060];

describe("порт на петле", () => {
  const proxyConf = readFileSync(
    new URL("../../deploy/proxy/auth.cmpas.ru.conf", import.meta.url), "utf8");
  const deployWf = readFileSync(
    new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

  /** Порт, который compose занимает на хосте. Единственный первоисточник. */
  const published = (compose.services.app!.ports ?? [])
    .map((p) => /^127\.0\.0\.1:(\d+):\d+$/.exec(p))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));

  it("публикуется ровно один порт", () => {
    expect(published).toHaveLength(1);
  });

  it("порт не отобран у соседа", () => {
    // Выкладка 719a773 встала на «Bind for 127.0.0.1:3100 failed:
    // port is already allocated»: 3100 держит zapiski-api. Занять
    // чужой порт нельзя, а «освободить» — тем более.
    expect(NEIGHBOUR_PORTS).not.toContain(published[0]);
  });

  it("nginx проксирует ровно на тот порт, который compose публикует", () => {
    // Расхождение здесь тише и хуже занятого порта: домен молча
    // отдаёт чужой сервис. Пока nginx смотрел на 3100, auth.cmpas.ru
    // проксировал на ЗАПИСКИ.
    const targets = [...proxyConf.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/g)]
      .map((m) => Number(m[1]));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toBe(published[0]);
  });

  it("проверка здоровья при выкладке не содержит порта отдельным числом", () => {
    // Иначе появляется четвёртое место, где порт можно забыть.
    expect(deployWf).not.toMatch(/127\.0\.0\.1:\d+\/healthz/);
  });
});

describe("зависимости боевого кода", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  /** Все внешние пакеты, которые импортирует src. */
  const imported = (() => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
          const spec = m[1]!;
          if (spec.startsWith(".") || spec.startsWith("node:")) continue;
          names.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
        }
      }
    };
    walk(root);
    return [...names].sort();
  })();

  it("каждый импортируемый пакет объявлен в dependencies, а не в devDependencies", () => {
    // В образе стоит npm ci --omit=dev: пакет из devDependencies туда
    // не доедет, и приложение упадёт при СТАРТЕ, а не при сборке.
    // Ровно так вышло с @fastify/middie: тесты идут от исходников, где
    // установлено всё, образ собирался успешно, а контейнер падал
    // с ERR_MODULE_NOT_FOUND уже на боевом сервере.
    const deps = Object.keys(pkg.dependencies ?? {});
    const missing = imported.filter((name) => !deps.includes(name));
    expect(missing).toEqual([]);
  });

  it("список импортов не пуст: проверка выше действительно что-то смотрит", () => {
    expect(imported.length).toBeGreaterThan(3);
  });
});

describe("почтовый отправитель", () => {
  it("релей задан значением по умолчанию: учредителю нечего прописывать", () => {
    // Р-3. Если бы адрес релея приходил только из секрета, письмо не
    // ушло бы до тех пор, пока человек его не заведёт.
    const env = compose.services.app!.environment as Record<string, string>;
    expect(env.SMTP_HOST).toContain("host.docker.internal");
    expect(env.MAIL_FROM).toContain("cmpas.ru");
  });

  it("контейнер видит хост: без этого имени релея в нём нет", () => {
    const app = compose.services.app as unknown as { extra_hosts?: string[] };
    expect(app.extra_hosts).toContain("host.docker.internal:host-gateway");
  });

  it("отправитель — с нашего домена, а не с чужого", () => {
    // Релей соседа принимает только домен cmpas.ru
    // (ALLOWED_SENDER_DOMAINS в его compose): чужой отправитель просто
    // не будет принят.
    const env = compose.services.app!.environment as Record<string, string>;
    expect(env.MAIL_FROM).toMatch(/@cmpas\.ru>?\}?$/);
  });
});
