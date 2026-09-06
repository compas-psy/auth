# Задача 15 — ответ context7 и проверка чужого репозитория чтением

## Вопрос

`query-docs` к `/nextauthjs/next-auth`: «Adding a custom OIDC provider with issuer and
allowDangerousEmailAccountLinking alongside existing providers».

## Ответ context7 — существенное

1. **`wellKnown` выводится из `issuer`** — `packages/core/src/lib/utils/providers.ts`:
   *«if (c.issuer) c.wellKnown ??= `${c.issuer}/.well-known/openid-configuration`»*.
   → **Это прямо подтверждает решение Задачи 6.** Провайдер смонтирован на `/oidc`, а
   `issuer` — `https://auth.cmpas.ru`; без метаданных, развешенных ещё и по адресу,
   выводимому из `issuer`, рецепт для ПРАКТИКИ не работал бы вовсе. В плане этого места нет.
2. **`allowDangerousEmailAccountLinking`** — `packages/core/src/lib/actions/callback/handle-login.ts`:
   без флага бросается `OAuthAccountNotLinked`, когда учётная запись с такой почтой уже
   существует. → Без флага живой пользователь ПРАКТИКИ при первом входе через СИМПАС получил
   бы ошибку вместо входа. План верен.
3. **Адрес обратного вызова** — `https://app.com/{basePath}/callback/{id}`, `basePath` для
   Next.js `/api/auth`. → `https://cmpas.ru/api/auth/callback/simpasid`. Совпадает с планом.

Расхождений с планом ответ не дал.

## Правило достоверности: что проверено чтением, а не планом

Прочитан `github.com/compas-psy/cmpas.ru` (клон на чтение, 06.09.2026):

| Утверждение | Где проверено | Результат |
|---|---|---|
| `next-auth 5 beta` | `package.json` | `^5.0.0-beta.30` — совпадает |
| Prisma 5.22 | `package.json` | `5.22.0` — совпадает |
| `session.strategy = "database"` | `src/auth.ts:41` | совпадает |
| Действующие провайдеры | `src/auth.ts:43-52` | `Yandex` и `Nodemailer` — совпадает |
| Адаптер | `src/auth.ts:39` | `PrismaAdapter(db)` |
| `AUTH_SECRET` трогать нельзя | `src/auth.ts:15-35` | в самом файле стоит проверка и предупреждение: смена значения инвалидирует все сессии |
| Next.js | `package.json` | `16.1.1` — в плане не назван |

Файл конфигурации — `src/auth.ts` в корне `src`, а не `src/lib/auth.ts`: в репозитории есть
и `src/lib/panel/auth.ts`, но это другое. Путь проверен чтением, как требует правило.

## Что из этого попало в рецепты

Рецепт ПРАКТИКИ приводит блок в той форме, в какой он встанет в существующий `src/auth.ts`:
провайдер добавляется третьим, `Yandex` и `Nodemailer` остаются, `secret` не переопределяется,
`wellKnown` не задаётся. Всё перечисленное проверяется тестами
`packages/id-client/test/recipes.spec.ts` — блок из markdown вычисляется, а не читается глазами.
