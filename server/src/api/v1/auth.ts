import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isFirstParty } from "../../oidc/clients.js";
import {
  issueTokens, rotateRefresh, revokeSession, TokenError, verifyAccessToken,
} from "../../services/tokens.js";
import { writeAudit } from "../../services/audit.js";
import { logger } from "../../lib/logging.js";
import { getPool } from "../../db/pool.js";
import { sha256 } from "../../lib/hash.js";
import { issueEmailCode, verifyEmailCode } from "../../services/emailCode.js";
import { THROTTLE_SECONDS } from "../../services/magicLink.js";
import { getAccountProfile } from "../../services/accounts.js";
import { sendEmailCode } from "../../services/mailer.js";
import { nativeAdapterFor } from "../../services/providers/native.js";
import { linkOrCreateByProvider } from "../../services/identityLink.js";
import type { Provider } from "../../services/accounts.js";

/**
 * Клиент называет себя заголовком X-Client-Id. Публичному клиенту
 * скрывать нечего: секрета у него нет и быть не может.
 */
export function clientIdOf(req: FastifyRequest): string | undefined {
  const header = req.headers["x-client-id"];
  return typeof header === "string" && header ? header : undefined;
}

/**
 * Первичный токен-API доступен ТОЛЬКО клиентам с first_party = true
 * (12_NATIVE_AUTH.md §3.1). Всем остальным — OIDC.
 *
 * Забыть эту проверку значит отдать всем желающим вход, спроектированный
 * в расчёте на доверенное приложение. Поэтому она стоит первой строкой
 * на всей группе /v1/auth/*, а не в каждой ручке по отдельности.
 */
export async function firstPartyGate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!(await isFirstParty(clientIdOf(req)))) {
    await writeAudit({ event: "first_party_denied", outcome: "fail", ip: req.ip });
    await reply.code(403).send({ error: "forbidden_client" });
  }
}

interface RefreshBody { refresh_token?: string }
interface LogoutBody { refresh_token?: string }

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/v1/auth/")) await firstPartyGate(req, reply);
  });

  /**
   * Начало входа по коду. ВСЕГДА 202, независимо от того, есть ли такой
   * аккаунт и не сработала ли пауза: разные ответы превращают ручку в
   * способ узнать, зарегистрирован ли человек в сервисе психологической
   * помощи (12_NATIVE_AUTH.md §3.2).
   */
  app.post("/v1/auth/email/start", async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string; device_key?: string; platform?: string; terms_version?: string;
    };
    if (!body.email || !body.device_key || !body.platform) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await issueEmailCode({
      email: body.email,
      deviceKey: body.device_key,
      platform: body.platform,
      termsVersion: body.terms_version,
    });
    if (!("throttled" in result)) {
      await sendEmailCode(body.email, result.code);
    }
    await writeAudit({ event: "email_start", outcome: "ok", ip: req.ip });
    return reply.code(202).send({ retry_after_seconds: THROTTLE_SECONDS });
  });

  /**
   * Проверка кода. Ответы «неверный код» и «попытки исчерпаны»
   * одинаковы по форме; время ответа выровнено, чтобы не давать оракула.
   */
  app.post("/v1/auth/email/verify", async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string; code?: string; device_key?: string; platform?: string;
    };
    if (!body.email || !body.code || !body.device_key) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const started = Date.now();
    const out = await verifyEmailCode({
      email: body.email, code: body.code, deviceKey: body.device_key,
    });
    await evenOutTiming(started);

    if ("error" in out) {
      await writeAudit({ event: "email_verify", outcome: "fail", ip: req.ip });
      return out.error === "too_many_attempts"
        ? reply.code(429).send({ error: "too_many_attempts" })
        : reply.code(400).send({ error: "invalid_code", attempts_left: out.attemptsLeft });
    }

    const platform = body.platform ?? "android";
    const pair = await issueTokens(out.accountId, {
      deviceKey: body.device_key, platform, client: "app",
    });
    const profile = await getAccountProfile(out.accountId);
    await writeAudit({
      accountId: out.accountId, event: "login_email_code", outcome: "ok", ip: req.ip,
    });
    return reply.send({
      access_token: pair.access_token,
      refresh_token: pair.refresh_token,
      expires_in: pair.expires_in,
      account: {
        id: profile?.id,
        email: profile?.email,
        email_verified: profile?.emailVerified ?? false,
        display_name: profile?.displayName ?? null,
        products: profile?.products ?? [],
      },
    });
  });

  /**
   * Обмен кода внешнего сервиса, полученного приложением от его SDK.
   *
   * Формы логина провайдера у нас нет, встроенного webview нет,
   * учётные данные провайдера не принимаются и не пересылаются
   * (12_NATIVE_AUTH.md §7). Сюда приходит только код.
   */
  app.post<{ Params: { provider: string } }>(
    "/v1/auth/provider/:provider/native",
    async (req, reply) => {
      const provider = req.params.provider;
      const body = (req.body ?? {}) as {
        provider_code?: string; provider_jwt?: string;
        device_key?: string; platform?: string;
        code_verifier?: string; provider_device_id?: string;
        state?: string; redirect_uri?: string;
      };
      // Ровно одно из двух. «Ни одного» — нечего обменивать; «оба» —
      // приложение само не знает, что предъявляет, и выбирать за него
      // мы не будем: угаданный выбор сломается молча и не сегодня.
      const предъявлено = Number(Boolean(body.provider_code)) + Number(Boolean(body.provider_jwt));
      if (предъявлено !== 1 || !body.device_key || !body.platform) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const adapter = nativeAdapterFor(provider);
      // Провайдера без подключённого и проверенного SDK здесь нет —
      // и на мобильном экране его тоже нет. Это следствие требования.
      if (!adapter) {
        return reply.code(400).send({ error: "provider_unavailable" });
      }

      let identity;
      try {
        // Что из этого обязательно — решает адаптер провайдера: VK
        // требует все три, Яндексу хватает кода. Проверка стоит там,
        // где известно требование, а не здесь списком на все случаи.
        identity = await adapter.exchange({
          code: body.provider_code,
          jwt: body.provider_jwt,
          codeVerifier: body.code_verifier,
          deviceId: body.provider_device_id,
          state: body.state,
          redirectUri: body.redirect_uri,
        });
      } catch (err) {
        await writeAudit({ event: "provider_exchange", provider, outcome: "fail", ip: req.ip });
        // Стадия — в ЛОГ, а не в ответ и не в журнал человека.
        //
        // Снаружи «подпись не сошлась», «профиль недоступен» и «в
        // профиле нет идентификатора» обязаны выглядеть одинаково:
        // различать их в ответе значит рассказывать подбирающему,
        // насколько он близок. Но и нам они были неразличимы — первый
        // живой вход через Яндекс не прошёл, и сказать почему было
        // нечем (issue #27).
        logger.warn({
          event: "provider_exchange_failed",
          provider,
          stage: exchangeFailureStage(err),
        });
        return reply.code(400).send({ error: "invalid_provider_code" });
      }

      // И-5: у каждой учётной записи всегда есть ПОДТВЕРЖДЁННАЯ почта.
      // Слово провайдера «адрес такой» без признака подтверждения его
      // не заменяет — ведёт на экран запроса почты (A7н).
      if (!identity.email || !identity.emailVerified) {
        return reply.code(422).send({ error: "email_required" });
      }

      const linked = await linkOrCreateByProvider({
        provider: provider as Provider,
        subject: identity.subject,
        email: identity.email,
      });
      if (linked === "identity_taken") {
        await writeAudit({ event: "provider_login", provider, outcome: "fail", ip: req.ip });
        return reply.code(409).send({ error: "identity_taken" });
      }

      const pair = await issueTokens(linked.accountId, {
        deviceKey: body.device_key, platform: body.platform, client: "app",
      });
      const profile = await getAccountProfile(linked.accountId);
      await writeAudit({
        accountId: linked.accountId, event: "login_provider_native",
        provider, outcome: "ok", ip: req.ip,
      });
      return reply.send({
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
        expires_in: pair.expires_in,
        account: {
          id: profile?.id,
          email: profile?.email,
          email_verified: profile?.emailVerified ?? false,
          display_name: profile?.displayName ?? null,
          products: profile?.products ?? [],
        },
      });
    },
  );

  /**
   * Ротация. Refresh всегда новый; приход потраченного гасит цепочку
   * устройства целиком и требует нового входа.
   */
  app.post("/v1/auth/token/refresh", async (req, reply) => {
    const body = (req.body ?? {}) as RefreshBody;
    if (!body.refresh_token) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const pair = await rotateRefresh(body.refresh_token);
      await writeAudit({ event: "token_refresh", outcome: "ok", ip: req.ip });
      return reply.send({
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
        expires_in: pair.expires_in,
      });
    } catch (e) {
      await writeAudit({ event: "token_refresh", outcome: "fail", ip: req.ip });
      if (e instanceof TokenError) {
        // Ответ один на все причины: различать «повтор обнаружен» и
        // «токена нет» значит подсказывать тому, кто подбирает.
        return reply.code(400).send({ error: "invalid_grant" });
      }
      throw e;
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const body = (req.body ?? {}) as LogoutBody;
    if (!body.refresh_token) return reply.code(204).send();
    const { rows } = await getPool().query<{ session_id: string; account_id: string }>(
      // Хеш считается в одном месте — lib/hash.ts. Второй путь
      // вычисления того же значения рано или поздно разойдётся с первым.
      `SELECT session_id, account_id FROM first_party_sessions
       WHERE refresh_hash = $1`,
      [sha256(body.refresh_token)],
    );
    const row = rows[0];
    if (row) {
      await revokeSession(row.account_id, row.session_id, "user_logout");
      await writeAudit({
        accountId: row.account_id, event: "logout", outcome: "ok", ip: req.ip,
      });
    }
    // 204 в любом случае: чужой или уже погашенный токен не повод
    // рассказывать, существовал ли он.
    return reply.code(204).send();
  });

  /**
   * Состав способов входа приходит с сервера, а не из сборки:
   * приложение не должно показывать кнопку в пустоту.
   *
   * На мобильной платформе провайдер показывается ТОЛЬКО если у него
   * подключён и проверен нативный SDK (12_NATIVE_AUTH.md §2.2).
   * Нет SDK — провайдера на экране нет, и это не ошибка, а следствие
   * требования.
   */
  app.get("/v1/auth/methods", async (req, reply) => {
    const platform = String(
      (req.query as Record<string, unknown> | undefined)?.platform ?? "web",
    );
    const { availableProviders, nativeAppIds, isMobilePlatform } =
      await import("../../services/providers/native.js");
    const providers = await availableProviders(platform);
    // Идентификаторы приложений нужны только тому, кто сам поднимает
    // SDK провайдера. В браузере уход к провайдеру делаем мы, и
    // называть их там незачем.
    if (!isMobilePlatform(platform)) {
      return reply.send({ email: true, providers });
    }
    const appIds = await nativeAppIds();
    return reply.send({
      email: true,
      providers,
      provider_app_ids: Object.fromEntries(
        providers.filter((p) => appIds[p]).map((p) => [p, appIds[p]!])),
    });
  });
}

/**
 * Выравнивание времени ответа. Ответ «неверный код» приходит после
 * запроса к базе, ответ «попытки исчерпаны» — раньше; разница во
 * времени сама по себе оракул (12_NATIVE_AUTH.md §2.1).
 */
const MIN_VERIFY_MS = 120;
async function evenOutTiming(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_VERIFY_MS) {
    await new Promise((r) => setTimeout(r, MIN_VERIFY_MS - elapsed));
  }
}

/** Доступно и снаружи: экран входа спрашивает то же самое. */
export async function currentSessionOf(token: string): Promise<string | null> {
  const claims = await verifyAccessToken(token);
  return claims?.sessionId ?? null;
}

export { issueTokens };

/**
 * Стадия отказа обмена одним машинным словом.
 *
 * Текст ошибки НЕ берётся: он может содержать что угодно, включая
 * присланное извне, а журналу нужно различать четыре случая, а не
 * пересказывать их. Чужая ошибка честно называется `unknown` — иначе
 * это слово стало бы самым частым в журнале, и журнал перестал бы
 * отвечать на вопрос, ради которого заведён.
 */
export function exchangeFailureStage(err: unknown): string {
  const stage = (err as { stage?: unknown } | null)?.stage;
  return typeof stage === "string" && stage ? stage : "unknown";
}
