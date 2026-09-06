# CMPAS Legal Implementation Guide

**Назначение:** инструкция для ChatGPT Codex, Claude Code и других coding-агентов по внедрению юридического пакета CMPAS в продукт.

**Базовый юридический пакет:** `CMPAS_Legal_Pack_v0.9_2026-08-14.docx` и его отдельные документы.

**Статус пакета:** рабочая юридическая редакция v0.9. Не публиковать как финальную v1.0, пока не заполнены реквизиты Оператора и не сверены с фактической инфраструктурой auth, hosting, analytics, messaging, payments, retention/backups и трансграничной передачей.

---

## 1. Роль coding-агента

Ты не юридический редактор. Твоя задача — **реализовать в коде юридическую архитектуру, уже определённую пакетом CMPAS**, а не переписывать её по своему усмотрению.

При реализации:

1. Сначала изучи существующую архитектуру репозитория: auth/account, routing, database/schema, settings, notifications, сервисы ПРАКТИКА / ЗАПИСКИ / МОМЕНТЫ, текущие `/legal`-страницы и существующие consent/terms-механизмы.
2. Найди уже существующие сущности и переиспользуй их, если они соответствуют требованиям ниже. Не создавай параллельный legal-stack без необходимости.
3. Делай хирургические изменения только в связанных модулях. Не рефактори несвязанный код.
4. Сохраняй стиль проекта и текущий стек.
5. Если фактическая архитектура конфликтует с юридическим пакетом, **не исправляй документ самостоятельно**. Зафиксируй mismatch, укажи затронутый пункт пакета и предложи технические варианты.
6. Не заменяй юридически значимые события простым boolean вроде `termsAccepted=true`.
7. Любое утверждение о готовности должно подтверждаться тестами и фактической проверкой UI/API/DB.

---

## 2. Source of Truth и иерархия документов

Юридическая система CMPAS строится как дерево:

```text
CMPAS Account
│
├── Центральное Пользовательское соглашение
│   ├── Профессиональное пользовательское соглашение
│   │   └── Особые условия ПРАКТИКИ
│   ├── Особые условия ЗАПИСОК
│   └── Особые условия МОМЕНТОВ
│
├── Центральная Политика ПДн / конфиденциальности
│   └── информационный документ, НЕ consent
│
└── Отдельное согласие на рекламу
    └── добровольное, granular по каналам, OFF по умолчанию
```

### Документы приоритета 1

| Code | Документ | Рекомендуемый URL |
|---|---|---|
| `cmpas_terms` | Центральное Пользовательское соглашение Экосистемы CMPAS | `/legal/terms` |
| `cmpas_privacy` | Центральная Политика обработки ПДн и конфиденциальности | `/legal/privacy` |
| `cmpas_professional` | Профессиональное пользовательское соглашение психолог ↔ платформа | `/legal/pro` |
| `cmpas_practice_terms` | Особые условия ПРАКТИКИ | `/legal/practice` |
| `cmpas_notes_terms` | Особые условия ЗАПИСОК | `/legal/notes` |
| `cmpas_moments_terms` | Особые условия МОМЕНТОВ | `/legal/moments` |
| `cmpas_marketing_consent` | Согласие на рекламу и обработку ПДн в рекламных целях | `/legal/consent/marketing` |

Также должен существовать публичный реестр сервисов:

`/legal/services`

Он не требует отдельного акцепта и показывает актуальные сервисы Экосистемы, их public name, status, legal terms и data domain.

---

## 3. Жёсткие правила реализации

### 3.1. Никаких предустановленных согласий

Запрещено:

```text
☑ Согласен на рекламу
☑ Согласен на обработку ПДн
```

Все consent-checkbox/switches должны быть **OFF / unchecked по умолчанию**.

### 3.2. Privacy Policy не акцептуется

Нельзя делать:

```text
□ Я принимаю Политику конфиденциальности
```

Политика — информационный документ. Пользователю даётся ссылка на неё до/в момент сбора ПДн и постоянный доступ после регистрации.

Просмотр Policy можно технически логировать, но событие просмотра **не является согласием**.

### 3.3. Договоры акцептуются действием

Центральное соглашение и специальные условия принимаются **однозначным пользовательским действием**, например:

```text
[Создать аккаунт]
[Активировать профессиональный режим]
[Начать работу в ПРАКТИКЕ]
[Начать пользоваться]
```

В непосредственной близости от кнопки должно быть ясно написано, какой документ принимается, и должна присутствовать ссылка на актуальную версию.

Не добавляй обязательный checkbox только ради юридического UX, если пакет его не требует.

### 3.4. Контент разных сервисов изолирован

Один `user_id` используется всей Экосистемой, но это **не означает общий доступ сервисов к пользовательскому содержимому**.

Минимальная модель доменов:

```text
Account Core
├── identity/auth/security
├── account settings
└── legal state

Practice Domain
└── professional/client data

Notes Domain
└── private notes content

Moments Domain
└── product usage/progress/preferences
```

Не создавай центральный pipeline, который автоматически собирает содержимое ЗАПИСОК, клиентские данные ПРАКТИКИ или чувствительные выводы МОМЕНТОВ для рекламы, AI training или общей аналитики.

### 3.5. Service messages != Marketing messages

Сервисные сообщения и рекламные сообщения должны иметь разные типы, templates/queues и правила отправки.

**Service message:** безопасность, OTP, подтверждение операции, запись, платёж, изменение договора, support.

**Marketing message:** акции, продвижение тарифов, новые продукты, коммерческие предложения.

Отзыв рекламного согласия не должен отключать критические сервисные сообщения.

---

## 4. Mapping: экран → событие → документ → способ принятия → лог

| Событие | Что показать | Механика | Required | Что записать |
|---|---|---|---|---|
| Создание первого CMPAS Account | `cmpas_terms` + ссылка на `cmpas_privacy` | кнопка `Создать аккаунт/Продолжить` = акцепт Terms | Да | `legal_acceptance` для Terms |
| Просмотр Privacy | `cmpas_privacy` | только просмотр | Нет | опциональный `policy_view`, не consent |
| Регистрация: реклама | `cmpas_marketing_consent` | отдельные channel switches | Нет | `consent_grant` только для выбранных каналов |
| Активация professional profile | `cmpas_professional` | кнопка активации = акцепт | Да для professional mode | отдельный `legal_acceptance` |
| Первое подключение ПРАКТИКИ | `cmpas_practice_terms` | кнопка начала работы = акцепт | Да для ПРАКТИКИ | отдельный `legal_acceptance` |
| Перед первым созданием/import клиента | заверение психолога | **непреднажатая обязательная checkbox один раз** | Да | `legal_attestation` |
| Первое подключение ЗАПИСОК | `cmpas_notes_terms` | кнопка начала использования = акцепт | Да для ЗАПИСОК | отдельный `legal_acceptance` |
| Первое подключение МОМЕНТОВ | `cmpas_moments_terms` | кнопка начала использования = акцепт | Да для МОМЕНТОВ | отдельный `legal_acceptance` |
| Изменение рекламных каналов | Marketing Consent | switches per channel | Нет | grant/revoke events по каждому каналу |
| Существенно новая версия договора | новая immutable version | blocking re-accept только соответствующего договора | Да до продолжения функции | новый `legal_acceptance` |
| Новая Privacy Policy | новая версия | notice + ссылка | Нет повторного акцепта | версия опубликована; уведомление при необходимости |

---

## 5. Экран регистрации CMPAS Account

Целевой UX:

```text
Создавая аккаунт, вы принимаете Пользовательское соглашение CMPAS.
Информация об обработке персональных данных — в Политике конфиденциальности.

[ Создать аккаунт ]

Получать новости и предложения CMPAS:
□ Email
□ Push
□ Мессенджер
□ SMS
```

Требования:

- ссылки на Terms и Privacy доступны до нажатия основной кнопки;
- marketing options не блокируют регистрацию;
- все marketing switches OFF;
- системное разрешение OS/browser на push **не считается** рекламным согласием;
- если marketing consent не дан, account создаётся нормально;
- рекламное согласие можно дать позднее в Settings.

---

## 6. Professional mode и ПРАКТИКА

### 6.1. Professional Agreement

При активации professional profile пользователь должен отдельно акцептовать `cmpas_professional`.

Логировать независимо от Central Terms:

```text
user_id
role = psychologist
legal_document = cmpas_professional
version
accepted_at
acceptance_event
source
```

### 6.2. ПРАКТИКА

Перед первым использованием ПРАКТИКИ:

1. показать ссылку на `cmpas_practice_terms`;
2. кнопка начала работы = акцепт;
3. записать отдельный acceptance event.

### 6.3. Заверение психолога перед первым клиентом

Перед **первым** созданием/import клиентской записи требуется отдельная непреднажатая checkbox.

Смысл текста должен соответствовать утверждённому пакету, например:

> Я подтверждаю, что являюсь оператором персональных данных своих клиентов и располагаю необходимыми правовыми основаниями для их обработки и передачи ПРАКТИКЕ для обработки по моему поручению.

Это **не consent психолога на свои ПДн**, а юридическое заверение.

Сохранять как отдельную сущность/event:

```text
attestation_code = practice_client_data_operator
wording_version
user_id
service_id = practice
confirmed_at
source_event
```

Не спрашивать повторно при каждом клиенте, пока текст/правовая модель не изменились.

### 6.4. Данные клиентов психолога

В профессиональном контуре:

- психолог определяет цели и состав клиентских данных;
- CMPAS/ПРАКТИКА технически обрабатывает их по поручению;
- не использовать client content для собственной рекламы;
- не использовать client content для обучения универсальных AI-моделей;
- не передавать client content другим сервисам Экосистемы автоматически;
- обеспечить export/delete/audit trail там, где это предусмотрено продуктом;
- при наличии client-consent feature фиксировать событие **по поручению психолога**, не выдавая его за consent клиента в пользу CMPAS.

---

## 7. ЗАПИСКИ

### Required behavior

- Special Terms принимаются при первом запуске сервиса.
- Содержимое private by default.
- Notes content не становится автоматически доступным ПРАКТИКЕ, МОМЕНТАМ или central analytics.
- Передача/экспорт возможны только через явную функцию пользователя.
- Не выполнять semantic scanning пользовательских заметок для рекламы по умолчанию.
- Не использовать содержимое для AI training без отдельной утверждённой правовой и продуктовой модели.

### Security recommendation

Если технически возможно без чрезмерного усложнения, проектировать client-side / end-to-end encryption для содержимого ЗАПИСОК так, чтобы сервер CMPAS не обладал ключом расшифрования.

Это recommendation, а не разрешение самовольно менять продуктовую архитектуру. Если стек не позволяет — зафиксировать tradeoff.

---

## 8. МОМЕНТЫ

Разделять минимум два класса событий.

### Functional product state

Примеры:

- started meditation;
- completed meditation;
- progress position;
- favorite;
- selected category/theme;
- reminder settings.

Может использоваться для работы самого сервиса: продолжить, показать историю, настроить рекомендации внутри продукта в утверждённой модели.

### Marketing profile

Не создавать автоматически рекламный профиль из чувствительных выводов о пользователе.

Запрещённый по умолчанию паттерн:

```text
часто слушает контент «паника»
→ inferred_condition = anxiety_disorder
→ использовать для рекламного таргетинга
```

Любая новая функция, которая строит чувствительные психологические/медицинские выводы или существенно меняет рекомендательную модель, должна быть помечена как **LEGAL REVIEW REQUIRED** до production.

---

## 9. Marketing Consent

### Каналы

Минимально поддержать независимые scopes:

```text
email
push
messenger
sms
```

### Правила

- каждый канал OFF по умолчанию;
- пользователь может включить 0..N каналов;
- пользователь может отключить канал отдельно;
- должен существовать action `Отключить всю рекламу`;
- revoke действует только на marketing, не на service notifications;
- grant/revoke логируется неизменяемым событием;
- текущий effective state вычисляется из истории или безопасно материализуется поверх неё;
- хранить версию текста consent, которую пользователь видел.

### Event model

Пример:

```text
consent_type = marketing
scope = cmpas_own_services
channel = email
status = granted | revoked
document_version
occurred_at
source_event
user_id
```

Не включать рекламу сторонних партнёров в этот scope без отдельного утверждённого consent-механизма.

---

## 10. Legal/Consent Registry: минимальная модель данных

Адаптируй названия под текущий стек, но **семантика должна сохраниться**.

### `legal_document`

```text
document_id
code
title
scope
service_id nullable
current_version
status
```

### `legal_document_version`

```text
document_id
version
effective_at
published_at
content_hash
immutable_url
material_change boolean
```

После публикации запись/контент версии immutable. Исправление текста = новая версия.

### `legal_acceptance`

```text
id
user_id
document_id
version
accepted_at
acceptance_event
source_app
source_screen
ip_metadata nullable
device_metadata nullable
```

### `legal_attestation`

```text
id
user_id
attestation_code
wording_version
service_id
confirmed_at
source_event
```

### `consent_grant` / `consent_event`

```text
id
user_id
consent_type
document_version
scope
channel
status = granted | revoked
occurred_at
source_event
```

### `service_registry`

```text
service_id
public_name
status
legal_terms_code
operator_role
data_domain
```

### `processor_registry`

Пока может быть internal/admin entity, но архитектурно предусмотреть:

```text
provider
purpose
categories
location
cross_border_status
contract_dpa_status
active_from
active_to
```

---

## 11. Legal document publication

Каждая опубликованная версия должна иметь:

- стабильный human-readable URL;
- номер версии;
- дату публикации/effective date;
- immutable content snapshot;
- `content_hash`;
- архив старых версий;
- возможность восстановить текст, который был актуален на дату конкретного acceptance event.

### Не делать

```text
/legal/terms всегда показывает только новый текст,
а база хранит acceptance=true без версии.
```

В таком варианте невозможно доказать, с чем пользователь согласился.

### Рекомендуемая структура

```text
/legal/terms                    -> current
/legal/terms/0.9                -> immutable archive
/legal/privacy                  -> current
/legal/privacy/0.9              -> immutable archive
...
```

Допускается и другой route scheme, если обеспечена та же семантика.

---

## 12. Re-acceptance и обновление документов

Не заставлять пользователя повторно принимать все документы при любом текстовом изменении.

Для каждой версии хранить:

```text
material_change = true | false
```

### `material_change = true`

Если изменён договор и требуется новый акцепт:

- поставить `reaccept_required` только для соответствующего документа/сервиса;
- до продолжения соответствующей функции показать новую версию;
- получить новое однозначное действие;
- сохранить новый acceptance event;
- предыдущую запись не удалять.

### Privacy Policy

По умолчанию новая Privacy Policy:

- публикуется новой версией;
- пользователь уведомляется, если это необходимо;
- **не превращается в checkbox/договор**.

Если новая обработка требует самостоятельного consent, реализуется новый consent flow, а не «принятие новой Privacy».

---

## 13. Migration существующей реализации CMPAS

Перед изменениями найти:

- текущие Terms/Privacy routes;
- checkbox `privacy accepted`, `terms accepted`, `marketing`, `personal data consent`;
- существующие поля `termsAccepted`, `consentGiven`, `privacyAccepted`;
- старые версии документов;
- текущие consent logs;
- места отправки email/SMS/push/Telegram сообщений;
- существующую профессиональную клиентскую модель.

### Правило миграции

Не объявлять старые boolean историческими доказательствами того, чего они фактически не доказывают.

Если старые данные содержат version/timestamp/source — мигрировать корректно.

Если содержат только `true/false`:

1. сохранить legacy state отдельно;
2. не фабриковать timestamp/version;
3. для новых юридически значимых событий использовать новый registry;
4. если новая версия документа требует re-accept, собрать новый корректный acceptance.

Не удалять старые audit records без отдельной причины.

---

## 14. Data isolation и permissions

Перед production проверить на уровне API/DB permissions:

### Account Core

Может знать общие account/legal данные, но не должен без необходимости получать full content domains.

### ПРАКТИКА

Доступ к professional/client data только для разрешённых professional flows.

### ЗАПИСКИ

Notes content не должен быть доступен через общий profile/analytics endpoint.

### МОМЕНТЫ

Usage events не должны автоматически включать свободный content из других сервисов.

### Cross-service transfer

Передача между сервисами должна быть:

- либо необходимой частью явно выбранной функции;
- либо отдельным осознанным действием пользователя.

Если появляется action вроде `Передать психологу`, показывать получателя и состав передаваемых данных до подтверждения.

---

## 15. Notifications architecture

Минимально ввести classification:

```text
notification_class = service | marketing
```

И применять правила:

```text
service -> допускается по соответствующему договорному/операционному основанию
marketing -> отправлять только если effective marketing consent для канала = granted
```

Добавить guard на стороне backend/job sender, а не только скрывать кнопку в UI.

При revoke marketing consent pending campaign/jobs по возможности должны перестать отправляться.

---

## 16. Обязательные тесты

Не считать legal-layer реализованным без тестов.

### Account

- пользователь может зарегистрироваться без marketing consent;
- Terms acceptance создаётся с version/timestamp/event;
- Privacy не создаёт consent event;
- ссылки на Terms/Privacy доступны до account creation.

### Marketing

- все switches OFF initial state;
- можно включить один канал независимо от остальных;
- revoke одного канала не влияет на другие;
- `disable all` отзывает все active marketing grants;
- после revoke marketing message backend не отправляет сообщение;
- service message продолжает отправляться при marketing=false.

### Professional / ПРАКТИКА

- ordinary user не имеет professional acceptance автоматически;
- activation creates Professional Agreement acceptance;
- first Practice use creates Practice Terms acceptance;
- первый client create/import блокируется без required attestation;
- после attestation повторно для каждого клиента checkbox не показывается;
- attestation хранит wording version.

### ЗАПИСКИ

- first use требует/фиксирует acceptance Special Terms;
- Notes content не появляется в central account/profile API;
- default sharing отсутствует.

### МОМЕНТЫ

- first use фиксирует Special Terms;
- functional tracking не включает marketing consent автоматически;
- отсутствие marketing consent не ломает product progress/history.

### Versioning

- acceptance старой версии сохраняется после публикации новой;
- immutable URL старой версии возвращает старый content/hash;
- material Terms change вызывает targeted re-accept;
- non-material update не заставляет принять всё заново;
- Privacy update не порождает fake consent.

---

## 17. Definition of Done — Priority 1

Задача считается завершённой только если:

- [ ] Все 7 документов опубликованы/подготовлены к публикации на своих routes.
- [ ] Реализован `/legal/services`.
- [ ] Каждая legal version immutable и имеет hash/version/effective date.
- [ ] Central Terms принимаются конклюдентным действием и логируются.
- [ ] Privacy Policy не требует checkbox.
- [ ] Professional Agreement имеет отдельный acceptance.
- [ ] ПРАКТИКА имеет отдельный acceptance.
- [ ] Перед первым client create/import реализовано обязательное непреднажатое attestation.
- [ ] ЗАПИСКИ и МОМЕНТЫ имеют отдельные service acceptances.
- [ ] Marketing consent optional и OFF по умолчанию по каждому каналу.
- [ ] Grant/revoke marketing работает в Settings.
- [ ] Service и Marketing notifications технически разделены.
- [ ] Новый Legal/Consent Registry хранит versioned evidence, а не только boolean.
- [ ] Старые acceptance/consent поля проанализированы и мигрированы без выдуманных данных.
- [ ] Cross-service content isolation проверена.
- [ ] Все обязательные тесты проходят.
- [ ] В PR/отчёте перечислены фактические processors, auth providers, analytics, hosting, messaging, payment providers и retention/backups, которые требуют финального legal review перед v1.0.

---

## 18. Перед финальной публикацией v1.0: mandatory factual review

Coding-агент должен собрать из реального кода/infra и вывести в отчёте, но **не придумывать**:

1. **Operator details**
   - ФИО ИП;
   - ИНН;
   - ОГРНИП;
   - legal/contact email;
   - адрес для юридически значимых сообщений.

2. **Authentication**
   - фактические способы входа;
   - OTP providers;
   - OAuth/identity providers;
   - какие данные от них получает CMPAS.

3. **Infrastructure / processors**
   - hosting;
   - DB/storage;
   - email;
   - SMS;
   - push;
   - messengers;
   - monitoring/error tracking;
   - analytics;
   - AI providers, если есть;
   - payment providers.

4. **Data location**
   - где реально расположены primary DB/storage/backups;
   - есть ли трансграничные передачи или иностранные SaaS.

5. **Retention**
   - account deletion SLA;
   - content deletion;
   - logs;
   - backups rotation;
   - support data;
   - consent/audit evidence.

6. **Payments**
   - разовая оплата/подписка;
   - автопродление;
   - tokenized payment methods;
   - cancel flow.

Если любой из этих фактов отличается от текста v0.9, **не маскировать расхождение**. Создать блок `LEGAL REVIEW REQUIRED` с точной ссылкой на документ/пункт и фактическое состояние системы.

---

## 19. Следующие очереди документов — не реализовывать как готовые legal flows без отдельной задачи

### Priority 2

- ГРАНИ и другие сервисы;
- шаблон документов психолог ↔ клиент;
- отдельное письменное согласие на специальные категории ПДн, если потребуется;
- consent для публичного распространения данных, если появятся public features;
- условия оплаты/подписки/автопродления;
- Cookie/Analytics notice после фиксации реального stack;
- публичный/внутренний реестр обработчиков;
- правила рекомендательных технологий, если применимы.

### Priority 3 — internal compliance

- актуализация уведомления Роскомнадзора;
- внутреннее положение по ПДн/ИБ;
- threat model;
- incident response 24/72;
- subject request workflow;
- retention & destruction;
- журнал согласий/акцептов;
- subprocessor governance;
- аудит соответствия legal text ↔ infrastructure.

Не включай эти документы в Priority 1 «на всякий случай».

---

## 20. Рабочий протокол для Codex / Claude Code

Для каждой итерации:

### Step 1 — Inspect

Изучи текущий код и перечисли:

- что уже существует;
- что можно переиспользовать;
- какие расхождения с этой инструкцией найдены.

### Step 2 — Plan

Дай короткий план изменений по конкретным файлам/modules и критерии проверки.

### Step 3 — Implement surgically

Меняй только связанные части. Не делай unrelated refactoring.

### Step 4 — Verify

Запусти релевантные:

- unit tests;
- integration tests;
- migration tests;
- typecheck/lint;
- build;
- UI/e2e tests для legal flows, если infrastructure позволяет.

### Step 5 — Report

В финальном отчёте укажи:

```text
IMPLEMENTED
- ...

VERIFIED
- command -> result

LEGAL/PRODUCT MISMATCHES
- none / list

REQUIRES OWNER DECISION
- only facts that cannot be resolved from repository/config
```

Не говори «готово», если migration/build/tests не проверены.

---

## 21. Запреты для coding-агента

Нельзя без отдельной задачи владельца:

- переписывать юридические формулировки пакета;
- объединять Terms и Privacy в один checkbox;
- делать marketing consent обязательным;
- ставить consent switches ON по умолчанию;
- автоматически считать consent выданным по факту использования сервиса;
- трактовать OS/browser push permission как рекламное согласие;
- автоматически передавать Notes/Practice content между сервисами;
- использовать private content для advertising/AI training;
- придумывать реквизиты ИП, providers, сроки хранения или географию серверов;
- удалять старые evidence/audit records при миграции;
- менять legal version content после публикации вместо создания новой версии;
- требовать повторного acceptance всех документов из-за изменения одного документа;
- реализовывать будущие P2/P3 consent flows «на всякий случай».

---

## 22. Главный инвариант

При любом техническом решении сохраняй следующую модель:

```text
ОДИН CMPAS ACCOUNT
        ↓
ЕДИНАЯ ИДЕНТИЧНОСТЬ И LEGAL STATE
        ↓
НЕСКОЛЬКО НЕЗАВИСИМЫХ DATA DOMAINS
        ↓
ДОГОВОРЫ ПРИНИМАЮТСЯ ДЕЙСТВИЕМ
PRIVACY ДОСТУПНА БЕЗ АКЦЕПТА
CONSENT СОБИРАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОН ДЕЙСТВИТЕЛЬНО НУЖЕН
MARKETING ВСЕГДА ДОБРОВОЛЬНЫЙ И OFF ПО УМОЛЧАНИЮ
ПРАКТИКА ОБРАБАТЫВАЕТ КЛИЕНТСКИЕ ДАННЫЕ ПО ПОРУЧЕНИЮ ПСИХОЛОГА
PRIVATE CONTENT НЕ СТАНОВИТСЯ ОБЩИМ ДАННЫМ ЭКОСИСТЕМЫ
```

Если предлагаемое изменение нарушает этот инвариант — останови именно эту часть реализации, зафиксируй конфликт и вынеси его на решение владельца продукта.
