-- 0015_simpas_links.sql — готовый файл для репозитория ЗАПИСОК.
--
-- Кладётся в server/migrations/ как есть. Номер 0015 проверен чтением:
-- последняя существующая миграция — 0014_sync_keys.sql.
--
-- ПРИНЦИП АДДИТИВНОСТИ: миграция только ДОБАВЛЯЕТ таблицу. Ни одной
-- существующей строки не трогает, ни одной колонки не меняет, ничего
-- не удаляет. users.yandex_id остаётся на месте и продолжает работать.
-- Живой пользователь не должен заметить, что мы что-то меняли.

CREATE TABLE simpas_links (
  -- Один человек продукта — одна личность СИМПАС, и наоборот.
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- sub из id_token. Устойчив, не меняется и не переиспользуется.
  simpas_sub text NOT NULL UNIQUE,
  linked_at  timestamptz NOT NULL DEFAULT now()
);

-- Обратный поиск: «кто это по нашему sub» на входе.
CREATE INDEX simpas_links_sub_idx ON simpas_links (simpas_sub);
