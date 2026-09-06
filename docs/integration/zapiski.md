# Переезд ЗАПИСОК на единый вход

Стек проверен чтением `github.com/compas-psy/zapiski` 06.09.2026: Fastify + `pg` без ORM,
монорепозиторий на pnpm, свой magic-link, свой Яндекс, пара access-JWT и refresh-токен,
refresh хранится хешем.

Фактические пути, а не предположения:

| Что | Где | Что там |
|---|---|---|
| Маршруты входа | `server/src/routes/auth.ts` | `/api/v1/auth/methods`, `/api/v1/auth/yandex`, `/api/v1/auth/yandex/callback`, ссылка из письма |
| Служба провайдера | `server/src/services/yandex.ts` | `authorizeUrl(state)`, `exchange(code)` — образец для нашей |
| Миграции | `server/migrations/*.sql` | последняя `0014_sync_keys.sql`, следующая — `0015` |
| Люди | `server/migrations/0001_accounts.sql` | `users(id, email, email_verified_at, yandex_id, deleted_at, …)`, уникальность `users_email_lower_key` по `lower(email)` |
| Сеансы | там же | `sessions(id, user_id, device_id, refresh_token_hash, created_at, last_used_at, expires_at, revoked_at, revoked_reason)` |

Строка ТЗ про `users_email_lower_key` подтвердилась дословно. Колонки `deleted_at` и
`yandex_id` на месте.

Инварианты, которые переезд не имеет права тронуть: И-1, И-3 и И-4. Единый вход отвечает на
вопрос «кто вы» и ничего не знает про хранилище: **вход и разблокировка хранилища — разные
действия, и второе никогда не следует из первого.**

## Шаг 1. Обмен кода — вызовами SDK, без ручного HTTP

<!-- блок exchange -->
```ts
import { createSimpasClient, createPkcePair, createState } from "@simpas/id-client";

const simpas = createSimpasClient({
  issuer: process.env.SIMPASID_ISSUER!,
  clientId: process.env.SIMPASID_CLIENT_ID!,
  clientSecret: process.env.SIMPASID_CLIENT_SECRET!,
});

// Начало входа
const { codeVerifier, codeChallenge } = createPkcePair();
const state = createState();
const nonce = createState();
// codeVerifier, state и nonce кладутся в свою короткую серверную сессию,
// а не в куку клиента и не в URL.
const url = await simpas.getAuthorizationUrl({
  redirectUri: process.env.SIMPASID_REDIRECT_URI!,
  state, nonce, codeChallenge,
});

// Возврат
const tokens = await simpas.exchangeCode({
  code, codeVerifier, redirectUri: process.env.SIMPASID_REDIRECT_URI!,
});
const claims = await simpas.verifyIdToken(tokens.id_token, { nonce });
// claims.sub — устойчивый идентификатор человека. Он и связывается
// с users.id ДОБАВЛЕНИЕМ строки, а не переписыванием существующей.
```

Ручного `fetch` к `/token` в рецепте нет намеренно: разбор ответа, проверка подписи и сверка
`nonce` — это то, где ошибаются, и это делает библиотека.

## Шаг 2. Связывание — только добавлением

Новая миграция `server/migrations/0015_simpas_links.sql` — готовый файл лежит в
`docs/deploy/zapiski-0015_simpas_links.sql`:

```sql
-- Связь с единой личностью СИМПАС. Только ДОБАВЛЕНИЕ строк.
CREATE TABLE simpas_links (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  simpas_sub text NOT NULL UNIQUE,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- Новая строка. Ни UPDATE по users.id, ни удалений.
INSERT INTO simpas_links (user_id, simpas_sub)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;
```

Поле `users.yandex_id` **не удаляется** и продолжает работать до подтверждённого завершения
миграции: оно перестаёт использоваться для входа, но остаётся на месте. Существующие маршруты
`/api/v1/auth/yandex` и ссылка из письма остаются как есть — единый вход добавляется третьим
способом, а `/api/v1/auth/methods` начинает возвращать про него признак.

## Шаг 3. Что не меняется

1. **Офлайн.** Приложение запускается, создаёт, редактирует, ищет и удаляет заметки без сети и
   без аккаунта. Экрана входа при первом запуске нет.
2. **Расшифровка.** Мастер-ключ выводится из пароля хранилища на устройстве. Сеть в расшифровке
   не участвует никогда, и единый вход об этом ничего не знает.
3. **Просроченный токен без сети** не выкидывает из приложения и не запирает локальные заметки.
4. **Продление своей сессии** идёт по своему refresh-токену, без обращения к единому входу.
   Обращение нужно только для нового входа — поэтому суточная недоступность никого
   не разлогинивает.

## Шаг 4. Экран, когда единый вход недоступен

```
Вход временно недоступен. Мы уже чиним.
Попробуйте через несколько минут.
Заметки на этом устройстве работают как обычно.
```

Третья строка обязательна и только для ЗАПИСОК. Технической ошибки на экране быть не должно.

## Шаг 5. Чего не делать

1. Не отправлять в единый вход ни пароль хранилища, ни его хеш, ни соль, ни подсказку, ни
   обёрнутый ключ. Ничего из этого он не примет — колонок под это нет и тест их не пропустит.
2. Не выводить разблокировку хранилища из факта входа.
3. Не делать `UPDATE` по `users.id` и не удалять строки.
4. Не выключать свой почтовый вход: он остаётся аварийным путём.
