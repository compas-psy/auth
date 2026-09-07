import { randomBytes } from "node:crypto";
import { getPool, withTransaction } from "../../db/pool.js";
import { sha256 } from "../../lib/hash.js";
import type { Provider } from "../accounts.js";
import type { NativeIdentity } from "./native.js";

/** Провайдер, входящий через браузер (OIDC/OAuth с редиректом). */
export interface WebProviderAdapter {
  provider: Provider;
  authorizationUrl(state: string): string;
  exchange(code: string): Promise<NativeIdentity>;
}

/**
 * Подключённые для веба провайдеры.
 *
 * Пусто, пока не переданы ключи. Провайдер без ключей не показывается
 * на экране и не обслуживается на маршруте возврата: кнопка, ведущая
 * в ошибку, хуже отсутствующей кнопки.
 */
const webProviders = new Map<Provider, WebProviderAdapter>();

export function registerWebProvider(adapter: WebProviderAdapter): void {
  webProviders.set(adapter.provider, adapter);
}

export function clearWebProviders(): void {
  webProviders.clear();
}

export function webProvider(provider: string): WebProviderAdapter | undefined {
  return webProviders.get(provider as Provider);
}

export function connectedWebProviders(): Provider[] {
  return [...webProviders.keys()];
}

/** Подключает то, для чего есть ключи. Зовётся один раз при сборке сервера. */
export async function connectConfiguredProviders(issuer: string): Promise<void> {
  const { yandexFromEnv } = await import("./yandex.js");
  const yandex = yandexFromEnv(issuer);
  if (yandex) registerWebProvider(yandex);
}

const STATE_TTL_MINUTES = 15;

/** Выпускает одноразовый state и запоминает его хешем. */
export async function issueLoginState(
  provider: Provider,
  interactionUid: string,
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO provider_login_states (state_hash, provider, interaction_uid, expires_at)
     VALUES ($1,$2,$3, now() + make_interval(mins => $4::int))`,
    [sha256(state), provider, interactionUid, STATE_TTL_MINUTES],
  );
  return state;
}

/**
 * Гасит state и возвращает взаимодействие, к которому он привязан.
 * Повторное предъявление не проходит: возврат от провайдера
 * одноразовый, как и код внутри него.
 */
export async function consumeLoginState(
  provider: string,
  state: string,
): Promise<{ interactionUid: string } | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; interaction_uid: string }>(
      `SELECT id, interaction_uid FROM provider_login_states
       WHERE state_hash = $1 AND provider = $2
         AND used_at IS NULL AND expires_at > now()
       FOR UPDATE SKIP LOCKED`,
      [sha256(state), provider],
    );
    const row = rows[0];
    if (!row) return null;
    await client.query(
      "UPDATE provider_login_states SET used_at = now() WHERE id = $1", [row.id]);
    return { interactionUid: row.interaction_uid };
  });
}

export async function purgeLoginStates(): Promise<number> {
  const { rowCount } = await getPool().query(
    "DELETE FROM provider_login_states WHERE expires_at < now() - interval '1 day'");
  return rowCount ?? 0;
}
