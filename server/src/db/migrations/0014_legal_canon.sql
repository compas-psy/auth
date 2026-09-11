-- 0014_legal_canon.sql — консент-центр приводится к канону
-- (13_LEGAL_CONSENT_CENTER_AUTH.md).
--
-- Три вещи, каждая из которых была дефектом приёмки юридического
-- контура, а не мелочью.

-- ── Д-1. Центральные тексты уезжают с домена продукта ────────────────
--
-- text_url вёл за полным текстом на cmpas.ru, то есть в ПРАКТИКУ.
-- Следствие не косметическое: центральный документ Экосистемы
-- физически принадлежал одному из сервисов, и его правка в чужом
-- репозитории меняла документ, который приняли пользователи всех
-- сервисов.
--
-- Колонка не обнуляется, а СНОСИТСЯ. Пустая колонка под тем же именем —
-- приглашение вписать туда чужой адрес снова, а §7.7 ТЗ запрещает
-- возврат к Д-1 безусловно. Текст теперь лежит здесь и отдаётся
-- отсюда; хранить указатель «где-то ещё» больше незачем.
ALTER TABLE legal_document_versions DROP COLUMN text_url;

-- ── Д-3. Особые условия ШАГОВ ────────────────────────────────────────
--
-- Продукт steps в системе есть с миграции 0011, документа нет.
-- Сервис без своих Особых условий не может быть подключён законно:
-- принимать нечего.
--
-- Заводится ДОКУМЕНТ, но НЕ редакция: текста нет, а сочинять
-- юридические формулировки агенту запрещено (§7.1). current_version
-- остаётся NULL — это и означает «условий пока нет», и по этому
-- признаку сервер отказывает в подключении ШАГОВ.
INSERT INTO legal_documents (code, title, acceptance, current_version) VALUES
  ('cmpas_steps_terms', 'Особые условия ШАГОВ', 'action', NULL);

-- ── §8.10. Реестр документов и реестр сервисов обязаны сходиться ─────
--
-- «Нет сервиса без Особых условий и Особых условий без сервиса» —
-- пункт приёмки, который до сих пор держался на внимательности.
-- Связь называется явно, и по ней же сервер решает, можно ли
-- подключить сервис.
ALTER TABLE legal_documents ADD COLUMN product text
  CHECK (product IN ('practice','zapiski','moments','steps'));

UPDATE legal_documents SET product = 'practice' WHERE code = 'cmpas_practice_terms';
UPDATE legal_documents SET product = 'zapiski'  WHERE code = 'cmpas_notes_terms';
UPDATE legal_documents SET product = 'moments'  WHERE code = 'cmpas_moments_terms';
UPDATE legal_documents SET product = 'steps'    WHERE code = 'cmpas_steps_terms';

-- Один сервис — одни Особые условия. Вторые завести нельзя даже по
-- недосмотру.
CREATE UNIQUE INDEX legal_documents_product_idx
  ON legal_documents (product) WHERE product IS NOT NULL;

-- ── §5.2 и §7.4. Опубликованная редакция неприкосновенна ─────────────
--
-- Доказательство согласия состоит из трёх частей: запись о событии,
-- текст редакции по неизменяемому адресу и совпадение отпечатков
-- (05_CONSENT_PDN.md §2.4). Отпечаток, который можно переписать, —
-- не доказательство, а его видимость.
--
-- PENDING → настоящий хеш разрешён: это и есть публикация текста.
-- Обратно и в сторону — никогда. Адрес редакции вечен, поэтому
-- удаление запрещено тоже.
CREATE FUNCTION legal_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'адрес редакции вечен: % % удалению не подлежит',
      OLD.code, OLD.version;
  END IF;
  IF OLD.content_hash <> 'PENDING' AND NEW.content_hash <> OLD.content_hash THEN
    RAISE EXCEPTION 'отпечаток опубликованной редакции % % неизменяем',
      OLD.code, OLD.version;
  END IF;
  IF NEW.immutable_url <> OLD.immutable_url OR NEW.effective_at <> OLD.effective_at THEN
    RAISE EXCEPTION 'адрес и дата вступления редакции % % неизменяемы',
      OLD.code, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legal_version_immutable_trg
  BEFORE UPDATE OR DELETE ON legal_document_versions
  FOR EACH ROW EXECUTE FUNCTION legal_version_immutable();
