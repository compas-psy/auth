import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Provider from "oidc-provider";
import { issueMagicLink, redeemMagicLink } from "../services/magicLink.js";
import { sendMagicLink } from "../services/mailer.js";
import { currentDocument } from "../services/consents.js";
import { browserProviders } from "../services/providers/native.js";
import { writeAudit } from "../services/audit.js";
import { coarsen } from "../lib/useragent.js";
import { getPool } from "../db/pool.js";
import { loadConfig } from "../config.js";
import { renderScreen } from "../ui/render.js";
import { PORTAL_CLIENT } from "./portalClient.js";
import type { ServiceCode } from "../ui/wording.js";
import {
  webProvider, issueLoginState, consumeLoginState,
} from "../services/providers/registry.js";
import { linkOrCreateByProvider } from "../services/identityLink.js";
import { findClient } from "./clients.js";

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

    // Шаг разрешения. Провайдер спрашивает его ПОСЛЕ входа, и без
    // ответа код клиенту не выдаётся вовсе: человек возвращался бы на
    // экран входа снова и снова, а вход не складывался бы никогда.
    //
    // Отдельного экрана здесь нет и не будет. Человек не видит слов
    // «OAuth», «scope», «разрешения» — это правило интерфейса. Договор
    // он принял действием на экране входа, а клиенты у нас не чужие:
    // динамическая регистрация выключена, каждый заведён нами вручную
    // в реестре. Поэтому разрешение выдаётся молча.
    if (details.prompt?.name === "consent") {
      const grantId = await grantFor(provider, details);
      const location = await provider.interactionResult(
        req.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true },
      );
      return reply.code(303).header("location", location).send();
    }

    const terms = await currentDocument("cmpas_terms");
    const service = await serviceOf(details.params.client_id as string | undefined);

    return reply
      .type("text/html; charset=utf-8")
      // Экран входа не кэшируется: на нём состав способов входа и
      // адрес взаимодействия, привязанный к одной попытке.
      .header("cache-control", "no-store")
      .send(renderScreen("SignIn", {
        uid: req.params.uid,
        service,
        // Состав способов — по ВИДУ ЭКРАНА, а не по устройству:
        // это браузер, и вход провайдером здесь идёт редиректом.
        providers: await browserProviders(),
        termsVersion: terms?.version ?? "0.9",
        /**
         * Экран взаимодействия — БРАУЗЕРНЫЙ, чем бы человек его ни
         * открыл. Здесь он определял себя по User-Agent, и с телефона
         * получалось «Введите код из письма» с шестью клетками под
         * цифры — а маршрут ниже отправляет ССЫЛКУ и другого не умеет.
         * Вводить в клетки было нечего.
         *
         * Код из письма — способ входа НАШЕГО ПРИЛОЖЕНИЯ (12_NATIVE_AUTH.md):
         * там ссылка увела бы человека в почтовый клиент и наружу из
         * приложения. У приложения свой путь, первичный токен-API, и
         * этого экрана оно не открывает вовсе.
         */
        platform: "web",
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
    // device_id присылает VK ID вместе с кодом; без него VK не
    // проводит обмен (документация VK ID, сверено через context7).
    Querystring: { code?: string; state?: string; error?: string; device_id?: string };
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
      identity = await adapter.exchange({
        code: req.query.code,
        state: req.query.state,
        // Приходит только от VK ID; остальные адаптеры его не смотрят.
        deviceId: req.query.device_id,
      });
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
interface InteractionDetails {
  params: Record<string, unknown>;
  prompt?: { name: string };
  grantId?: string;
  session?: { accountId?: string };
}

/**
 * Разрешение на запрошенный состав сведений.
 *
 * Существующий грант продлевается, а не заводится заново: иначе второй
 * вход того же человека в тот же продукт плодил бы записи.
 */
async function grantFor(provider: Provider, details: InteractionDetails): Promise<string> {
  const clientId = String(details.params.client_id ?? "");
  const accountId = details.session?.accountId;
  const existing = details.grantId
    ? await provider.Grant.find(details.grantId)
    : undefined;
  const grant = existing ?? new provider.Grant({ accountId, clientId });
  // Ровно то, что запросил клиент. Ничего сверх запрошенного не
  // выдаётся: лишний состав сведений — это лишние данные у продукта.
  grant.addOIDCScope(String(details.params.scope ?? "openid"));
  return grant.save();
}

async function detailsFor(
  provider: Provider,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<InteractionDetails | null> {
  try {
    const details = await provider.interactionDetails(req.raw, reply.raw);
    return details as unknown as InteractionDetails;
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
/**
 * Какой продукт назван на экране входа.
 *
 * Берётся из реестра клиентов (колонка product), а не угадывается по
 * префиксу client_id. Прежняя эвристика объявляла ПРАКТИКОЙ всё, что
 * не начинается с zapiski/moments: клиент ЗАПИСОК, названный
 * «notes-desktop», показал бы человеку чужое имя продукта. Тексты
 * экранов берутся из макета дословно, и подстановка чужого названия —
 * дефект приёмки, а не мелочь.
 *
 * Клиент без указанного продукта и неизвестный клиент — ПРАКТИКА:
 * экран обязан открыться, а не упасть.
 */
export async function serviceOf(clientId: string | undefined): Promise<ServiceCode> {
  if (!clientId) return "practice";
  // Портал аккаунта опознаётся ПО КЛИЕНТУ, а не по колонке product.
  // В реестре у него practice — как у всего, что живёт рядом с
  // ПРАКТИКОЙ, — и чинить заголовок правкой строки в базе значило бы
  // лечить экран изменением данных.
  if (clientId === PORTAL_CLIENT) return "account";
  const client = await findClient(clientId);
  return client?.product ?? "practice";
}
