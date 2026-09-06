-- 0007_first_party.sql — цепочки refresh первичного токен-API.
--
-- Мобильное приложение — публичный клиент: секрета у него нет и быть не
-- может, всё зашитое в APK извлекается. Поэтому безопасность держится не
-- на секрете, а на одноразовости refresh и на обнаружении повторного
-- использования (12_NATIVE_AUTH.md §3.2).
--
-- Строка на КАЖДУЮ выдачу, а не на устройство: чтобы поймать повтор,
-- потраченный токен обязан остаться в базе. Цепочка (chain_id) гасится
-- целиком — это стандартная реакция на украденный токен.

CREATE TABLE first_party_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain_id       uuid NOT NULL,
  device_key     text NOT NULL,
  platform       text NOT NULL,
  -- Только хеш. Сырой refresh не хранится нигде.
  refresh_hash   text NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX first_party_sessions_chain_idx ON first_party_sessions (chain_id);
CREATE INDEX first_party_sessions_account_idx ON first_party_sessions (account_id);
CREATE INDEX first_party_sessions_session_idx ON first_party_sessions (session_id);
