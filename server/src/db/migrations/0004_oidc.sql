-- 0004_oidc.sql — хранилище протокола.
--
-- Структуру определяет библиотека; наше дело — адаптер и сроки жизни
-- (02_SIMPASID.md §4.2). Проверено чтением node_modules/oidc-provider@8.8.1:
-- lib/adapters/memory_adapter.js — эталонный адаптер, по которому сверен
-- контракт; lib/models/mixins/consumable.js — consume(); has_grant_id.js —
-- revokeByGrantId().

CREATE TABLE oidc_payloads (
  id          text NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  grant_id    text,
  user_code   text,
  uid         text,
  -- NULL означает «без срока»: динамически зарегистрированный клиент
  -- приходит в upsert без expiresIn.
  expires_at  timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (type, id)
);
CREATE INDEX oidc_payloads_grant_idx ON oidc_payloads (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX oidc_payloads_uid_idx   ON oidc_payloads (type, uid) WHERE uid IS NOT NULL;
CREATE INDEX oidc_payloads_user_code_idx
  ON oidc_payloads (type, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX oidc_payloads_expiry_idx ON oidc_payloads (expires_at) WHERE expires_at IS NOT NULL;

-- Реестр клиентов.
--
-- first_party решает, пускать ли клиента в первичный токен-API
-- (12_NATIVE_AUTH.md §3.1). Забыть эту проверку значит отдать всем
-- желающим вход, спроектированный в расчёте на доверенное приложение.
--
-- client_secret хранится как есть, а не хешем, и это осознанно: проверка
-- client_secret_basic/client_secret_post по протоколу требует, чтобы
-- сервер держал сам общий секрет. Хеш сделал бы проверку невозможной.
-- Это долгоживущий секрет клиента, а не одноразовый секрет человека:
-- запрет И-2 про вторые, и имена колонок его не нарушают.
-- Публичным клиентам (мобильным) секрет не выдаётся вовсе: у них NULL
-- и token_endpoint_auth_method = 'none', безопасность держится на PKCE
-- и одноразовости refresh.
CREATE TABLE oidc_clients (
  client_id        text PRIMARY KEY,
  client_name      text NOT NULL,
  client_secret    text,
  redirect_uris    text[] NOT NULL DEFAULT '{}',
  post_logout_uris text[] NOT NULL DEFAULT '{}',
  grant_types      text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
  auth_method      text NOT NULL DEFAULT 'client_secret_basic'
                   CHECK (auth_method IN ('client_secret_basic','client_secret_post','none')),
  first_party      boolean NOT NULL DEFAULT false,
  product          text CHECK (product IN ('practice','zapiski','moments')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz
);

-- Публичный клиент обязан быть без секрета, конфиденциальный — с ним.
-- Пустой секрет у конфиденциального клиента означал бы вход по пустой строке.
ALTER TABLE oidc_clients ADD CONSTRAINT oidc_clients_secret_matches_method
  CHECK (
    (auth_method = 'none' AND client_secret IS NULL)
    OR (auth_method <> 'none' AND length(client_secret) >= 32)
  );
