# Задача 6 — ответ context7 и расхождения с планом

## Вопрос

`query-docs` к `/panva/node-oidc-provider`: «How to mount oidc-provider on Fastify: callback
handler, prefix mounting, exact code example?»

## Ответ context7 — дословно существенное

**«Mount oidc-provider to Fastify»** (`docs/README.md`):

```js
// assumes fastify ^5.0.0
const fastify = new Fastify();
await fastify.register(await import("@fastify/middie"));
fastify.use("/oidc", provider.callback());
```

**«Mounting oidc-provider»**: *«When mounting the oidc-provider instance to a path prefix, it
is necessary to update the `interactions.url` configuration. Additionally, ensure that
authorization server metadata endpoints are correctly configured on the host application to
resolve to the provider routes, depending on the issuer identifier and the chosen mount path.»*

## Что из ответа сделано

1. **`@fastify/middie`**, а не `@fastify/express`: меньше поверхности, тот же результат.
   Ответ называет оба; выбран первый.
2. **`interactions.url`** переопределён на `/interaction/{uid}` — экран взаимодействия наш,
   с нашими текстами.
3. **Метаданные развешаны по обоим адресам.** Это прямое следствие второй цитаты и место,
   которого в плане нет вовсе. Провайдер смонтирован на `/oidc`, а `issuer` по CLAUDE.md —
   `https://auth.cmpas.ru`. Клиент, которому дали только `issuer` (а именно так устроен рецепт
   для ПРАКТИКИ: `next-auth` выводит `wellKnown` из `issuer`), пойдёт за метаданными на
   `/.well-known/openid-configuration`. Без этой пары рецепт Задачи 15 не работает.
   Источник истины один — документ отдаёт сам провайдер, второй адрес его переспрашивает.
4. **Префикс провайдер выводит сам** — проверено чтением
   `lib/helpers/oidc_context.js:88-96`: `mountPath` берётся из `req.originalUrl` минус
   `request.url`. Поэтому `authorization_endpoint` объявляется как
   `https://auth.cmpas.ru/oidc/auth`, а не `…/auth`. Закреплено тестом.

## Расхождения с планом

1. **Ошибка протокола возвращается на `redirect_uri` кодом 303, а не 400/302.**
   План ждал `[400, 302]`. Так требует OAuth 2.0 §4.1.2.1: если `redirect_uri` действителен,
   ошибка едет на него. 400 остаётся там, где редиректить нельзя — при чужом или неточно
   совпавшем `redirect_uri`. Верна библиотека; тесты приведены к её поведению, обе ветки
   проверяются отдельно.
2. **`grantTypes` задать нельзя.** План его не трогает, но соблазн есть: поле выводится из
   `responseTypes` и `scopes` (`lib/helpers/configuration.js:176-200`). `implicit` не
   появляется потому, что `responseTypes` — только `code`; `refresh_token` появляется из-за
   `offline_access`. Проверено тестом на `grant_types_supported`.
3. **`pkce.methods` отсутствует в `@types/oidc-provider`,** хотя есть в рантайме
   (`lib/helpers/defaults.js:2176-2182`). Типы отстали. Верен рантайм: без этого поля остаётся
   разрешён и `plain`, то есть PKCE без защиты. Оставлено с приведением типа и комментарием.
4. **Тесты обязаны ходить с заголовками боевого контура.** `app.inject` по умолчанию идёт на
   `http://localhost`, и провайдер отвергает запрос как небезопасный **до** проверки
   параметров — то есть тест проверял бы не то, что происходит в бою. Добавлены
   `Host: auth.cmpas.ru` и `X-Forwarded-Proto: https`, `provider.proxy = true`.

## Р-2: что именно достигнуто и где граница

| Cookie | Имя | Domain | Флаги |
|---|---|---|---|
| сессия SSO | `__Host-simpas_session` | **не задан** | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` |
| взаимодействие | `simpas_interaction` | **не задан** | `HttpOnly`, `Secure`, `SameSite=Lax`, суженный `Path` |
| возобновление | `simpas_interaction_resume` | **не задан** | то же |

Префикс `__Host-` стоит на cookie сессии SSO — на той самой, которая даёт право сменить способ
входа, и ради которой требование Р-2 написано. На cookie взаимодействия его нет и **быть не
может**: библиотека выдаёт их с суженным `Path`
(`lib/actions/authorization/interactions.js:130`, `resume.js:80`), а браузер отвергает
`__Host-` при любом `Path`, кроме `/`. Атрибут `Domain` не задаётся ни у одной cookie —
именно это требование Р-2 и защищает, и оно выполнено полностью.

Умолчание библиотеки `cookies.long.sameSite: 'none'` переопределено на `lax`.
