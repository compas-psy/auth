export interface Config {
  databaseUrl: string;
  issuer: string;
  port: number;
  host: string;
  /** Каталог тома, где живут ключи подписи. Задача 16, шаг 4. */
  keysDir: string;
  /** Куда уводит человека кнопка возврата, если продукт не назвался. */
  isProduction: boolean;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const required = ["DATABASE_URL", "ISSUER"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env: ${key}`);
  }
  const issuer = process.env.ISSUER!;
  if (!/^https?:\/\//.test(issuer)) {
    throw new Error("ISSUER must be an absolute URL");
  }
  // issuer без завершающего слэша: oidc-provider строит из него все адреса
  // discovery, и лишний слэш даёт «https://auth.cmpas.ru//oidc/token».
  cached = {
    databaseUrl: process.env.DATABASE_URL!,
    issuer: issuer.replace(/\/+$/, ""),
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    keysDir: process.env.KEYS_DIR ?? "/var/lib/simpasid/keys",
    isProduction: process.env.NODE_ENV === "production",
  };
  return cached;
}

/** Только для тестов: сбросить запомненную конфигурацию. */
export function resetConfig(): void {
  cached = undefined;
}
