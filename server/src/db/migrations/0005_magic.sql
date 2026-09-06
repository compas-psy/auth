-- 0005_magic.sql — вход по почте.
--
-- Структура копирует уже проверенное решение ЗАПИСОК: токен только хешем,
-- TTL, одноразовость, привязка к устройству, пауза на сервере.
--
-- Колонки otp здесь нет и не будет: она прямо запрещена И-2. Код из письма
-- для мобильных (Н2) — тот же одноразовый секрет, и живёт он в этой же
-- таблице, в token_hash (12_NATIVE_AUTH.md §2.1).

CREATE TABLE magic_link_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  -- Сырой секрет не хранится нигде. Уникальность по хешу заодно
  -- исключает повторную выдачу одного и того же значения.
  token_hash text NOT NULL UNIQUE,
  device_key text NOT NULL,
  platform   text NOT NULL,
  -- Согласия едут вместе с токеном: аккаунта в момент нажатия ещё нет,
  -- и записать акцепт больше некуда (02_SIMPASID.md §4.2).
  terms_version    text,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX magic_link_tokens_email_idx
  ON magic_link_tokens (lower(email), created_at DESC);
CREATE INDEX magic_link_tokens_expiry_idx ON magic_link_tokens (expires_at);
