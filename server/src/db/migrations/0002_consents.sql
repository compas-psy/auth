-- 0002_consents.sql — согласия журналом событий.
--
-- Плоская таблица consents из 02_SIMPASID.md §4.2 здесь ОТМЕНЕНА решением
-- 05_CONSENT_PDN.md §6.1: отзыв обязан быть новой записью, а не
-- проставлением revoked_at в старой, иначе история отзывов и повторных
-- согласий не восстанавливается.

CREATE TABLE legal_documents (
  code            text PRIMARY KEY,
  title           text NOT NULL,
  -- action  — акцепт действием (содержательная кнопка)
  -- consent — отдельное добровольное согласие (переключатель)
  -- none    — информационный документ, не принимается вовсе
  acceptance      text NOT NULL CHECK (acceptance IN ('action','consent','none')),
  current_version text
);

-- После публикации строка неизменяема (05_CONSENT_PDN.md §6.2).
CREATE TABLE legal_document_versions (
  code            text NOT NULL REFERENCES legal_documents(code),
  version         text NOT NULL,
  owner_id        uuid,
  effective_at    timestamptz NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  content_hash    text NOT NULL,
  -- Ссылка ведёт на конкретную редакцию, а не на текущую
  -- (CMPAS_LEGAL_IMPLEMENTATION.md §11, задание 08 §2.4 п. 2).
  immutable_url   text NOT NULL,
  material_change boolean NOT NULL DEFAULT false,
  PRIMARY KEY (code, version)
);

CREATE TABLE consent_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Возрастающий номер: два события в одну миллисекунду обязаны
  -- упорядочиваться детерминированно, иначе действующее состояние скачет.
  seq              bigserial NOT NULL,
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_code    text NOT NULL,
  document_version text NOT NULL,
  content_hash     text NOT NULL,
  status           text NOT NULL CHECK (status IN ('granted','revoked')),
  action           text NOT NULL,
  source           text NOT NULL CHECK (source IN ('web','android','desktop')),
  channel          text CHECK (channel IN ('email','push','messenger')),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  ip_hash          text,
  ua_hash          text,
  -- Согласие на неопубликованную редакцию недоказуемо: доказательством
  -- служит связка «редакция + content_hash того, что человек видел».
  FOREIGN KEY (document_code, document_version)
    REFERENCES legal_document_versions (code, version)
);
CREATE INDEX consent_events_account_idx ON consent_events (account_id, occurred_at DESC);
CREATE INDEX consent_events_lookup_idx
  ON consent_events (account_id, document_code, channel, occurred_at DESC, seq DESC);

-- Неизменяемость обеспечивается базой, а не соглашением.
--
-- Замечание плана учтено: правила DO INSTEAD NOTHING молча проглатывают
-- запись, и «журнал не изменился» становится неотличимо от «изменение
-- прошло». Триггер бросает ошибку — попытка правки видна.
CREATE FUNCTION consent_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_events_no_update_trg
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION consent_events_immutable();

-- Реестр документов. Редакция 0.9 — из CMPAS_Legal_Pack_v0.9.
-- content_hash здесь ЗАГЛУШКА: настоящий хеш приходит вместе с
-- опубликованным текстом документа, а тексты в репозитории не лежат
-- (00_ЧИТАТЬ_ПЕРВЫМ.md, «Чего в пакете нет намеренно»).
INSERT INTO legal_documents (code, title, acceptance, current_version) VALUES
  ('cmpas_terms',              'Пользовательское соглашение СИМПАС',            'action',  '0.9'),
  ('cmpas_privacy',            'Политика обработки персональных данных',        'none',    '0.9'),
  ('cmpas_professional',       'Профессиональное пользовательское соглашение',  'action',  '0.9'),
  ('cmpas_practice_terms',     'Особые условия ПРАКТИКИ',                       'action',  '0.9'),
  ('cmpas_notes_terms',        'Особые условия ЗАПИСОК',                        'action',  '0.9'),
  ('cmpas_moments_terms',      'Особые условия МОМЕНТОВ',                       'action',  '0.9'),
  ('cmpas_marketing_consent',  'Согласие на получение рекламных сообщений',     'consent', '0.9'),
  ('practice_client_consent',  'Согласие клиента психолога',                    'consent', '0.9');

INSERT INTO legal_document_versions
  (code, version, effective_at, content_hash, immutable_url, material_change) VALUES
  ('cmpas_terms',             '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/terms/0.9',              false),
  ('cmpas_privacy',           '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/privacy/0.9',            false),
  ('cmpas_professional',      '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/professional/0.9',       false),
  ('cmpas_practice_terms',    '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/practice-terms/0.9',     false),
  ('cmpas_notes_terms',       '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/notes-terms/0.9',        false),
  ('cmpas_moments_terms',     '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/moments-terms/0.9',      false),
  ('cmpas_marketing_consent', '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/marketing-consent/0.9',  false),
  ('practice_client_consent', '0.9', '2026-09-03T00:00:00Z', 'PENDING', '/legal/client-consent/0.9',     false);
