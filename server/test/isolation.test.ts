import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

  it("проксирует на петлю, а не на чужой порт", () => {
    expect(conf).toContain("proxy_pass http://127.0.0.1:3100");
    expect(conf).not.toContain(":3000");
  });
});
