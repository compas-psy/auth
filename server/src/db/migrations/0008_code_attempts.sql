-- 0008_code_attempts.sql — счётчик попыток для кода из письма.
--
-- Шестизначный код — это миллион вариантов, на несколько порядков
-- меньше, чем 32 случайных байта в ссылке. Перебор закрывается не
-- длиной, а ограничениями (12_NATIVE_AUTH.md §2.1).
--
-- Счётчик живёт НА СТРОКЕ КОДА, а не в памяти процесса и не в кэше:
-- перезапуск контейнера или второй экземпляр обнулили бы защиту.
ALTER TABLE magic_link_tokens
  ADD COLUMN attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN burned_at    timestamptz,
  -- link — ссылка для веба, code — код для мобильных. Один и тот же
  -- одноразовый секрет, одно и то же хранение: только хешем.
  ADD COLUMN kind         text NOT NULL DEFAULT 'link'
             CHECK (kind IN ('link','code'));
