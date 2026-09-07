-- 0010_provider_states.sql — одноразовый state входа через провайдера.
--
-- state связывает возврат от провайдера с той попыткой входа, из
-- которой человек ушёл. Без него возврат подделывается: достаточно
-- заманить человека на наш /callback с чужим кодом.
--
-- Хранится ТОЛЬКО хешем и гасится при первом использовании — так же,
-- как токен магической ссылки и refresh. Одноразовых секретов в
-- открытом виде в базе не появляется.
CREATE TABLE provider_login_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash      text NOT NULL UNIQUE,
  provider        text NOT NULL CHECK (provider IN ('yandex','tid','sberid','vkid')),
  -- Взаимодействие, из которого начат вход: к нему же и возвращаемся.
  interaction_uid text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);
CREATE INDEX provider_login_states_expiry_idx ON provider_login_states (expires_at);
