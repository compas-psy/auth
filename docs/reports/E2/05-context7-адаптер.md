# Задача 5 — ответ context7 и что он изменил

## Вопрос

`resolve-library-id` → `/panva/node-oidc-provider`.
`query-docs`: «What is the exact Adapter interface contract including consume and
revokeByGrantId semantics?»

## Что ответил context7

Существенное из ответа:

* **«Configuration > adapter»** (`docs/README.md`): *«While a default in-memory adapter is
  provided for development and testing, it is not suitable for production as all data is lost
  upon restart. Production environments must implement a custom adapter»*.
  → **Совпадает с планом.** Собственный адаптер обязателен.
* `revokeByGrantId` вызывается из `lib/helpers/revoke.js` по всем моделям сразу:
  `.map((model) => model && model.revokeByGrantId(grantId))`.
  → Отзыв гранта обязан уносить записи **всех типов**, не только того, на котором вызван.
* Адаптер для модели `Client` должен убирать `null`-поля (архивный changelog).
  → На Э2 не касается: клиенты статические, через адаптер не ходят.

## Чего context7 не дал и как это добрано

Точных сигнатур методов ответ не содержит. Контракт снят **чтением установленного пакета**
`oidc-provider@8.8.1` — это и есть эталон:

| Источник | Что установлено |
|---|---|
| `node_modules/oidc-provider/lib/adapters/memory_adapter.js` | эталонный адаптер целиком: `upsert(id, payload, expiresIn)`, `find`, `findByUid`, `findByUserCode`, `consume`, `destroy`, `revokeByGrantId` |
| `lib/adapters/memory_adapter.js:41-43` | `consume(id)` ставит `consumed = epochTime()` — **секунды**, не миллисекунды |
| `lib/models/base_model.js:69` | `upsert` зовётся как `adapter.upsert(this.jti, payload, ttl)`; `ttl` в секундах |
| `lib/models/mixins/consumable.js:9` | `consume()` модели зовёт `adapter.consume(jti)` |
| `lib/models/mixins/has_grant_id.js:2` | `revokeByGrantId` — статический метод модели поверх адаптера |
| `lib/actions/grants/authorization_code.js:90` | `if (code.consumed)` — библиотека читает поле из **найденного** payload |
| `lib/models/session.js:42`, `lib/models/device_code.js:17` | `findByUid` и `findByUserCode` |

## Расхождения с планом, устранённые по факту

1. **`expiresIn` может отсутствовать.** План строит интервал как
   `now() + ($7 || ' seconds')::interval`. При `expiresIn === undefined` это даёт
   `'undefined seconds'` и вставка падает. Заменено на `make_interval(secs => $7::bigint)`
   с `NULL` при отсутствии срока; закрыто тестом «запись без срока жизни хранится бессрочно».
2. **`upsert` в плане обновляет только `payload` и `expires_at`.** Производные колонки
   `grant_id`, `user_code`, `uid` при обновлении оставались бы прежними, и сессия после смены
   `uid` не находилась бы по новому. Обновляются все.
3. **`consume` должен гасить, а не удалять** — иначе повторное предъявление кода выглядит как
   «кода не было», и грант не уничтожается. В плане это верно; закреплено отдельным тестом,
   что `consumed` — секунды эпохи.
4. **Индексы `uid` и `user_code` в плане не учитывают тип.** Один `uid` теоретически возможен
   в двух моделях; поиск идёт всегда с типом. Индексы сделаны составными и частичными.

Сверх плана добавлено: `purgeExpiredPayloads()` — хранилище протокола не должно расти вечно.
