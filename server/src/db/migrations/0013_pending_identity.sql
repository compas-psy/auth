-- 0013_pending_identity.sql — личность провайдера, ждущая подтверждения почты.
--
-- Ветка И-5: провайдер не дал подтверждённой почты, значит учётную
-- запись заводить нельзя, пока человек не назовёт и не подтвердит адрес.
-- Человека уводили на экран «Нужна электронная почта» — и личность
-- провайдера теряли. Даже подтвердив почту, при следующем входе тем же
-- провайдером человек снова оказывался на этом экране. Каждый раз.
--
-- Здесь она и ждёт: привязана к попытке входа, живёт пятнадцать минут,
-- гасится при первом использовании. Ключевого материала не содержит —
-- только то, чем провайдер назвал человека.
CREATE TABLE pending_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_uid text NOT NULL UNIQUE,
  provider        text NOT NULL CHECK (provider IN ('yandex','tid','sberid','vkid')),
  subject         text NOT NULL,
  -- Адрес, который провайдер всё-таки назвал, но не подтвердил. Нужен,
  -- чтобы подставить его человеку в поле, а не заставлять набирать.
  claimed_email   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);
CREATE INDEX pending_identities_expiry_idx ON pending_identities (expires_at);

-- Личность едет вместе с токеном письма: человек может открыть ссылку
-- в другой вкладке или на другом устройстве, и связь с попыткой входа
-- там уже не поможет.
ALTER TABLE magic_link_tokens
  ADD COLUMN pending_provider text
    CHECK (pending_provider IS NULL OR pending_provider IN ('yandex','tid','sberid','vkid')),
  ADD COLUMN pending_subject  text;

-- Половина связи бессмысленна: либо оба поля, либо ни одного.
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_pending_pair
  CHECK ((pending_provider IS NULL) = (pending_subject IS NULL));
