import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Provider from "oidc-provider";
import { issueMagicLink, redeemMagicLink } from "../services/magicLink.js";
import { sendMagicLink } from "../services/mailer.js";
import { currentDocument } from "../services/consents.js";
import { availableProviders } from "../services/providers/native.js";
import { writeAudit } from "../services/audit.js";
import { coarsen } from "../lib/useragent.js";
import { getPool } from "../db/pool.js";
import { loadConfig } from "../config.js";
import { renderScreen } from "../ui/render.js";
import type { Product } from "../services/accounts.js";
import {
  webProvider, issueLoginState, consumeLoginState,
} from "../services/providers/registry.js";
import { linkOrCreateByProvider } from "../services/identityLink.js";

/**
 * Экраны взаимодействия. Живут вне контура библиотеки: это наши экраны,
 * с нашими текстами и нашей юридической конструкцией.
 */
export async function registerInteractionRoutes(
  app: FastifyInstance,
  provider: Provider,
): Promise<void> {
  /** Экран входа (артборды A1-A5). */
  app.get<{ Params: { uid: string } }>("/interaction/:uid", async (req, reply) => {
    const details = await detailsFor(provider, req, reply);
    if (!details) return;

    const platform = coarsen(req.headers["user-agent"]).platform ?? "web";
    const terms = await currentDocument("cmpas_terms");
    const service = serviceOf(details.params.client_id as string | undefined);

    return reply
      .type("text/html; charset=utf-8")
      // Экран входа не кэшируется: на нём состав способов входа и
      // адрес взаимодействия, привязанный к одной попытке.
      .header("cache-control", "no-store")
      .send(renderScreen("SignIn", {
        uid: req.params.uid,
        service,
        providers: await availableProviders(platform),
        termsVersion: terms?.version ?? "0.9",
        platform: platform === "android" || platform === "ios" ? platform : "web",
      }));
  });

  /**
   * Отправка почты. Акцепт действием: человек нажал содержательную
   * кнопку, и на экране прямо сказано, какую редакцию он принимает.
   */
  app.post<{ Params: { uid: string } }>("/interaction/:uid/email", async (req, reply) => {
    const details = await detailsFor(provider, req, reply);
    if (!details) return;

    const body = (req.body ?? {}) as { email?: string };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email.includes("@")) return reply.code(400).send({ error: "invalid_request" });

    const terms = await currentDocument("cmpas_terms");
    const issued = await issueMagicLink({
      email,
      // Ссылка привязана к тому взаимодействию, из которого начата.
      deviceKey: req.params.uid,
      platform: "web",
      termsVersion: terms?.version,
    });
    if (!("throttled" in issued)) {
      const url = `${loadConfig().issuer}/interaction/${req.params.uid}/callback?token=${issued.token}`;
      await sendMagicLink(email, url);
    }
    await writeAudit({ event: "magic_link_requested", outcome: "ok", ip: req.ip });

    // Ответ один и тот же и для известного адреса, и для неизвестного,
    // и когда сработала пауза: иначе ручка становится способом узнать,
    // зарегистрирован ли человек.
    return reply.header("cache-control", "no-store").send({ status: "sent" });
  });

  /**
   * Кнопка «Войти через …»: уводим к провайдеру с одноразовым state.
   *
   * Формы логина провайдера у нас нет и быть не может — человек уходит
   * к нему самому и возвращается уже опознанным.
   */
  app.get<{ Params: { uid: string; provider: string } }>(
    "/interaction/:uid/provider/:provider",
    async (req, reply) => {
      const details = await detailsFor(provider, req, reply);
      if (!details) return;

      const adapter = webProvider(req.params.provider);
      // Провайдера без ключей на экране нет, и маршрут его не знает.
      if (!adapter) return reply.code(404).send({ error: "provider_unavailable" });

      const state = await issueLoginState(adapter.provider, req.params.uid);
      await writeAudit({
        event: "provider_start", provider: adapter.provider, outcome: "ok", ip: req.ip,
      });
      return reply
        .code(303)
        .header("cache-control", "no-store")
        .header("location", adapter.authorizationUrl(state))
        .send();
    },
  );

  /**
   * Возврат от провайдера. Это тот самый адрес, который зарегистрирован
   * у провайдера как Redirect URI: https://auth.cmpas.ru/callback/<провайдер>.
   */
  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>("/callback/:provider", async (req, reply) => {
    const html = (code: number, screen: string, state: Record<string, unknown> = {}) =>
      reply.code(code).type("text/html; charset=utf-8")
        .header("cache-control", "no-store").send(renderScreen(screen, state));

    // Отказ провайдера — это не наша ошибка и не повод показывать его
    // машинный код человеку.
    if (req.query.error || !req.query.code || !req.query.state) {
      await writeAudit({
        event: "provider_callback", provider: req.params.provider,
        outcome: "fail", ip: req.ip,
      });
      return html(400, "ProviderFailed");
    }

    const adapter = webProvider(req.params.provider);
    if (!adapter) return html(400, "ProviderFailed");

    const consumed = await consumeLoginState(req.params.provider, req.query.state);
    if (!consumed) {
      // Подделанный, просроченный или уже использованный возврат.
      await writeAudit({
        event: "provider_state", provider: req.params.provider,
        outcome: "fail", ip: req.ip,
      });
      return html(400, "ProviderFailed");
    }

    let identity;
    try {
      identity = await adapter.exchange(req.query.code);
    } catch {
      await writeAudit({
        event: "provider_exchange", provider: adapter.provider,
        outcome: "fail", ip: req.ip,
      });
      return html(400, "ProviderFailed");
    }

    // И-5: у каждой учётной записи всегда есть подтверждённая почта.
    // Нет её — ведём на экран C2, а запись НЕ заводим.
    if (!identity.email || !identity.emailVerified) {
      return html(200, "EmailRequired", { provider: adapter.provider });
    }

    const linked = await linkOrCreateByProvider({
      provider: adapter.provider, subject: identity.subject, email: identity.email,
    });
    if (linked === "identity_taken") {
      await writeAudit({
        event: "provider_login", provider: adapter.provider, outcome: "fail", ip: req.ip,
      });
      // Артборд C3.
      return html(409, "IdentityTaken");
    }

    const device = coarsen(req.headers["user-agent"]);
    await getPool().query(
      `INSERT INTO sessions (account_id, platform, client, device_key, kind)
       VALUES ($1,$2,$3,$4,'sso')`,
      [linked.accountId, device.platform, device.client, consumed.interactionUid],
    );
    await writeAudit({
      accountId: linked.accountId, event: "login_provider",
      provider: adapter.provider, outcome: "ok", ip: req.ip,
    });

    const location = await provider.interactionResult(
      req.raw, reply.raw,
      { login: { accountId: linked.accountId, remember: true } },
      { mergeWithLastSubmission: false },
    );
    return reply.code(303).header("location", location).send();
  });

  /** Переход по ссылке из письма — конец входа. */
  app.get<{ Params: { uid: string }; Querystring: { token?: string } }>(
    "/interaction/:uid/callback",
    async (req, reply) => {
      const token = req.query.token;
      if (!token) return reply.code(400).send({ error: "invalid_request" });

      const redeemed = await redeemMagicLink(token);
      if (!redeemed) {
        await writeAudit({ event: "magic_link_redeem", outcome: "fail", ip: req.ip });
        return reply.code(400).type("text/html; charset=utf-8").send(
          renderScreen("LinkExpired", {}),
        );
      }

      const device = coarsen(req.headers["user-agent"]);
      await getPool().query(
        `INSERT INTO sessions (account_id, platform, client, device_key, kind)
         VALUES ($1,$2,$3,$4,'sso')`,
        [redeemed.accountId, device.platform, device.client, req.params.uid],
      );
      await writeAudit({
        accountId: redeemed.accountId, event: "login_magic_link", outcome: "ok", ip: req.ip,
      });

      // Дальше решение возвращается библиотеке: грант, код и редирект —
      // её дело, а не наше.
      const result = {
        login: { accountId: redeemed.accountId, remember: true },
      };
      const location = await provider.interactionResult(
        req.raw, reply.raw, result, { mergeWithLastSubmission: false },
      );
      return reply.code(303).header("location", location).send();
    },
  );
}

/**
 * Подробности взаимодействия. Чужой или истёкший uid не открывает
 * ничего: библиотека сама проверяет привязку к cookie.
 */
async function detailsFor(
  provider: Provider,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ params: Record<string, unknown> } | null> {
  try {
    const details = await provider.interactionDetails(req.raw, reply.raw);
    return details as unknown as { params: Record<string, unknown> };
  } catch {
    await reply.code(404).send({ error: "interaction_not_found" });
    return null;
  }
}

/**
 * Какому продукту принадлежит клиент — человек должен видеть, куда он
 * входит: он нажал «Войти» в конкретном продукте и попал на другой
 * домен, и смена домена без объяснения это ровно то, чему учат
 * не доверять.
 */
function serviceOf(clientId: string | undefined): Product {
  if (!clientId) return "practice";
  if (clientId.startsWith("zapiski")) return "zapiski";
  if (clientId.startsWith("moments")) return "moments";
  return "practice";
}
