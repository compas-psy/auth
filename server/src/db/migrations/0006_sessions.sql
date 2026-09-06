-- 0006_sessions.sql — устройства и сеансы (артборд L2).
--
-- Решение П-2 от 06.09.2026: огрублённые поля platform и client
-- ДОБАВЛЯЮТСЯ — так, как их уже показывает артборд R2 в ответе API.
--
-- Чего здесь нет и не будет: IP-адреса и полного user-agent. Человек
-- видит семейство платформы и клиента без версии, и на экране L2 прямо
-- написано, почему: «Мы не храним ваш IP-адрес и точное устройство —
-- только то, что видно выше».

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Огрублённое семейство платформы: windows, macos, android, ios, linux.
  platform       text,
  -- Огрублённый клиент БЕЗ версии: chrome, safari, firefox, app.
  client         text,
  -- Ключ устройства, присланный приложением. Не идентифицирует человека
  -- и нужен, чтобы отличать сеансы одного аккаунта друг от друга.
  device_key     text,
  kind           text NOT NULL DEFAULT 'first_party'
                 CHECK (kind IN ('first_party','sso')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_account_idx ON sessions (account_id, last_seen_at DESC);
CREATE INDEX sessions_active_idx ON sessions (account_id) WHERE revoked_at IS NULL;
