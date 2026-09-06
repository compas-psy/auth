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
