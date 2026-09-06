-- 0000_extensions.sql
-- gen_random_uuid() для первичных ключей. Собственной генерации
-- идентификаторов нет: это тоже криптография, а её мы не пишем.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
