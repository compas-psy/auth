import Provider, { type Configuration } from "oidc-provider";
import { PostgresAdapter } from "./adapter.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKeys } from "../lib/keys.js";
import { getPool } from "../db/pool.js";

/** Путь, по которому провайдер смонтирован на Fastify. */
export const OIDC_MOUNT = "/oidc";

/**
 * Экран взаимодействия живёт вне контура провайдера — это наш экран,
 * с нашими текстами и нашей юридической конструкцией.
 */
function interactionUrl(_ctx: unknown, interaction: { uid: string }): string {
  return `/interaction/${interaction.uid}`;
}

/**
 * Claim'ы учётной записи. Вынесены из замыкания findAccount, чтобы
 * свойство «неподтверждённая почта наружу не уходит» можно было
 * проверить тестом, а не надеяться на него.
 *
 * ПОЧЕМУ email отдаётся только подтверждённым. Продукт на next-auth
 * связывает вход с существующим пользователем ПО ПОЧТЕ и на
 * email_verified не смотрит вовсе (проверено через context7:
 * packages/core/src/lib/actions/callback/handle-login.ts). Рецепт
 * ПРАКТИКИ включает allowDangerousEmailAccountLinking осознанно —
 * без него живой пользователь получил бы OAuthAccountNotLinked вместо
 * входа. Но тогда неподтверждённая почта в claim'е — это готовый
 * захват чужой учётной записи продукта: назвал чужой адрес, вошёл в
 * чужие данные. Доверие продукт оказал нам, значит и проверка наша.
 */
export type AccountClaims = { sub: string } & Record<string, unknown>;

export async function accountClaims(sub: string): Promise<AccountClaims | undefined> {
  const { rows } = await getPool().query<{
    id: string; display_name: string | null; email: string | null; verified_at: Date | null;
  }>(
    `SELECT a.id, a.display_name, e.email, e.verified_at
     FROM accounts a
     LEFT JOIN account_emails e ON e.account_id = a.id AND e.is_primary
     WHERE a.id = $1 AND a.status = 'active'`,
    [sub],
  );
  const row = rows[0];
  if (!row) return undefined;
  const verified = row.verified_at !== null;
  return {
    sub,
    // Не «email с email_verified: false», а отсутствие email.
    email: verified ? (row.email ?? undefined) : undefined,
    email_verified: verified,
    name: row.display_name ?? undefined,
  };
}

export async function buildProvider(): Promise<Provider> {
  const { issuer, isProduction } = loadConfig();
  const jwks = loadOrCreateKeys();

  const configuration: Configuration = {
    adapter: PostgresAdapter as never,

    /**
     * Статического перечня клиентов НЕТ — и это не упущение.
     *
     * Перечень, прочитанный при запуске, означает, что клиент,
     * заведённый после выкладки, не существует для работающего
     * сервиса: именно так портал аккаунта отвечал живому человеку
     * invalid_client, будучи заведённым в реестре. Отключение клиента
     * точно так же не действовало бы до перезапуска.
     *
     * Клиентов отдаёт адаптер (server/src/oidc/adapter.ts): библиотека
     * спрашивает его о каждом клиенте, которого нет в статическом
     * перечне. Реестр oidc_clients — единственный источник истины,
     * и он читается в момент запроса.
     *
     * НЕ ВОЗВРАЩАТЬ статический clients: это возвращает дефект.
     */
    jwks,

    // PKCE обязателен для ВСЕХ клиентов, включая серверные
    // (02_SIMPASID.md §6.1). Только S256: plain не даёт защиты,
    // ради которой PKCE и существует.
    // methods есть в рантайме 8.8.1 (lib/helpers/defaults.js:2176),
    // но отсутствует в @types/oidc-provider — типы отстали от библиотеки.
    // Верен рантайм: без этого поля остаётся разрешён и plain.
    pkce: { required: () => true, methods: ["S256"] } as Configuration["pkce"],

    // Ответы только code. Ни implicit, ни password grant:
    // паролей нет и быть не может. Перечень grant_types библиотека
    // выводит отсюда и из scopes (offline_access -> refresh_token),
    // задать его отдельно нельзя — проверено чтением
    // lib/helpers/configuration.js:176-200.
    responseTypes: ["code"],

    /**
     * Подсказка провайдера в запросе авторизации.
     *
     * Просьба продукта: у ПРАКТИКИ на экране два кружка — Яндекс и VK, —
     * и кружок VK, ведущий в общий список, обещает одно, а показывает
     * другое. Так устроено у всех: `kc_idp_hint` у Keycloak,
     * `connection` у Auth0.
     *
     * Подсказка ВЫБИРАЕТ, а не пропускает: наш экран показывается
     * всегда. Пользовательское соглашение принимается действием на нём
     * и больше нигде (§1 14_LEGAL_PRODUCTS_UNIFIED.md) — уведи человека
     * прямо к провайдеру, и юридической строки он не увидит, а брать
     * акцепт будет негде.
     *
     * Проверяющей функции нет намеренно: опечатка в ссылке продукта не
     * должна превращаться в отказ входа. Неизвестное значение просто
     * никого не выделяет (interactions.ts).
     *
     * Параметры регистрируются здесь и приходят в ctx.oidc.params —
     * сверено с документацией oidc-provider через context7.
     */
    extraParams: ["provider"],

    scopes: ["openid", "email", "profile", "offline_access"],
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      // name — только если человек сам его ввёл. Ни ФИО из провайдера,
      // ни аватара (02_SIMPASID.md §2.8, §4.3).
      profile: ["name"],
    },

    /**
     * Кто может обращаться к протокольным ручкам ИЗ БРАУЗЕРА.
     *
     * Умолчание библиотеки отвергает ЛЮБОЙ запрос с заголовком Origin
     * (lib/helpers/defaults.js: clientBasedCORS возвращает false и
     * печатает предупреждение при первом вызове). А браузер шлёт Origin
     * на КАЖДЫЙ POST — включая запрос на собственный домен.
     *
     * Из-за этого портал аккаунта не мог обменять код на ключ: человек
     * доходил до конца входа и получал «Вход временно недоступен».
     * На боевом это выглядело так:
     *   {"error":"invalid_request","error_description":
     *    "origin https://auth.cmpas.ru not allowed for client: account-portal"}
     *
     * Проверки этого не ловили, потому что ходили без Origin: они
     * доказывали механизм обмена, но не то, что обмен пройдёт из
     * браузера. Теперь сквозная проверка портала шлёт Origin, как
     * браузер, и без этой настройки краснеет.
     *
     * Разрешён РОВНО наш собственный домен, и это ничего не открывает:
     * запрос со своего же домена браузер и так считает своим, правило
     * общего происхождения его не ограничивает. Продукты обменивают код
     * НА СЕРВЕРЕ, без браузера, и заголовка Origin у них нет вовсе —
     * их этот разбор не касается.
     */
    clientBasedCORS: (_ctx, origin) => origin === new URL(issuer).origin,

    // alg: none отвергается тем, что его нет в перечне.
    enabledJWA: { idTokenSigningAlgValues: ["RS256"] },

    /**
     * email и email_verified кладутся В САМ id_token.
     *
     * По умолчанию (conformIdTokenClaims: true) провайдер строго
     * следует Core 1.0: при выдаче кода в id_token попадает только
     * sub, остальное — на userinfo (документация oidc-provider, FAQ
     * «ID Token does not include claims other than sub»).
     *
     * Нам это не подходит: наш собственный чек-лист переезда
     * (docs/integration/checklist.md, пункт 4) требует от продукта
     * ПРОВЕРЯТЬ email_verified в id_token, а рецепт обещает там email.
     * Обещание и реализация обязаны совпадать — иначе продукт напишет
     * проверку, которая молча ничего не проверит: undefined !== false.
     *
     * Утечки здесь нет: id_token уходит по обратному каналу тому же
     * клиенту, который уже получил запрошенный им состав сведений.
     *
     * НЕ ВОЗВРАЩАТЬ К УМОЛЧАНИЮ. ПРАКТИКА проверяет email_verified
     * строго: только явное true, отсутствующий claim — отказ (issue
     * compas-psy/cmpas.ru#132, ответ агента 07.09.2026). Снятие этой
     * строки не «ослабит проверку», а остановит все входы через единый
     * вход. Закреплено в login.e2e.test.ts.
     */
    conformIdTokenClaims: false,

    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      // Back-Channel Logout не внедряется на этапах 1–4
      // (02_SIMPASID.md §6.1): единственный сценарий, где он нужен,
      // уже решается списком сессий в продукте.
      backchannelLogout: { enabled: false },
      rpInitiatedLogout: { enabled: true },
      resourceIndicators: { enabled: false },
      registration: { enabled: false },
      deviceFlow: { enabled: false },
    },

    interactions: { url: interactionUrl as never },

    // Р-2. Атрибут Domain не задаётся НИКОГДА: auth.cmpas.ru —
    // поддомен cmpas.ru, и cookie сервиса идентичности не имеет права
    // уезжать в ПРАКТИКУ.
    //
    // ПОЧЕМУ У COOKIE ВЗАИМОДЕЙСТВИЯ path=«/», А НЕ СУЖЕННЫЙ.
    //
    // По умолчанию библиотека выдаёт их с Path=/interaction/<uid>
    // (проверено заголовком Set-Cookie, не предположено). Возврат от
    // внешнего сервиса приходит на /callback/<провайдер> — адрес
    // ПОСТОЯННЫЙ, он зарегистрирован у провайдера, и uid в него не
    // вставить. На этот путь браузер суженную cookie не отправляет,
    // взаимодействие не находится, и человек получает экран «Вход
    // временно недоступен» — при пустом журнале, потому что отказ
    // приходит с кодом 400, а пишутся только 500-е.
    //
    // Вход по почте это не задевало: его возврат живёт под
    // /interaction/<uid>/callback. Проверка тоже не задевала: она
    // отбрасывала Path и слала cookie куда угодно.
    //
    // Р-2 при этом не нарушается: Domain не задаётся, cookie остаётся
    // на хосте auth.cmpas.ru и в ПРАКТИКУ не уезжает. А раз Path стал
    // «/» при Secure и без Domain — на cookie взаимодействия вернулся
    // префикс __Host-, который до этого был невозможен.
    //
    // НА COOKIE ВОЗОБНОВЛЕНИЯ ПРЕФИКСА НЕТ, И ЭТО НЕ НЕДОСМОТР.
    // Библиотека выдаёт её со СВОИМ путём — /oidc/auth/<uid>, — и
    // cookies.short его не перебивает (проверено заголовком). Браузер
    // отвергает __Host- при любом Path, кроме «/», то есть префикс на
    // ней не усилил бы защиту, а выбросил бы cookie целиком и сломал
    // шаг возобновления. Узкий путь здесь и не мешает: туда человека
    // уводит наш собственный 303, адрес известен.
    cookies: {
      names: {
        session: "__Host-simpas_session",
        interaction: "__Host-simpas_interaction",
        resume: "simpas_interaction_resume",
      },
      long: { httpOnly: true, sameSite: "lax", secure: true, signed: true, path: "/" },
      short: { httpOnly: true, sameSite: "lax", secure: true, signed: true, path: "/" },
      keys: [cookieSigningKey()],
    },

    ttl: {
      // Короткая сессия SSO: она нужна только чтобы второй продукт
      // не спрашивал вход заново (02_SIMPASID.md §6.2).
      Session: 14 * 24 * 60 * 60,
      Interaction: 15 * 60,
      Grant: 14 * 24 * 60 * 60,
      AuthorizationCode: 60,
      AccessToken: 15 * 60,
      IdToken: 15 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
    },

    async findAccount(_ctx: unknown, sub: string) {
      const claims = await accountClaims(sub);
      if (!claims) return undefined;
      return { accountId: sub, claims: async () => claims };
    },

    renderError(ctx, out) {
      // Наружу уходит описание ошибки протокола, а не стек.
      ctx.type = "application/json";
      ctx.body = JSON.stringify({
        error: out.error,
        error_description: out.error_description,
      });
    },
  };

  const provider = new Provider(issuer, configuration);
  // За реверс-прокси схема и хост приходят заголовками; без этого
  // провайдер решит, что работает по http, и откажет Secure-cookie.
  provider.proxy = true;
  void isProduction;
  return provider;
}

/**
 * Ключ подписи cookie. Берётся из того же тома, что и ключи JWT:
 * учредитель его не задаёт (Р-3).
 */
function cookieSigningKey(): string {
  const keys = loadOrCreateKeys();
  const first = keys.keys[0];
  // Значение из приватного ключа: оно уже секретно, лежит в томе с
  // режимом 600 и переживает перезапуск — cookie не разлогинивает.
  return String(first?.d ?? first?.kid ?? "simpasid");
}
