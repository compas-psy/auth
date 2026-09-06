-- 0003_audit.sql — журнал значимых событий.
--
-- У-9 (02_SIMPASID.md §8): почта, sub, токены и пути не пишутся никогда.
-- IP-адрес и полный user-agent не хранятся вовсе — только хеши, и человеку
-- на экране L2 прямо сказано, почему список беднее, чем у крупных сервисов.

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE SET NULL, а не CASCADE: удаление учётной записи обезличивает
  -- журнал, но не стирает факт события. Иначе после удаления нечем
  -- разбирать инцидент, который к удалению и привёл.
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  event      text NOT NULL,
  provider   text,
  outcome    text NOT NULL CHECK (outcome IN ('ok','fail')),
  at         timestamptz NOT NULL DEFAULT now(),
  ip_hash    text,
  ua_hash    text
);
CREATE INDEX audit_log_account_idx ON audit_log (account_id, at DESC);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
