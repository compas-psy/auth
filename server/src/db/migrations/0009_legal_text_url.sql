-- 0009_legal_text_url.sql — адрес опубликованного текста документа.
--
-- Тексты документов в этом репозитории не лежат намеренно
-- (00_ЧИТАТЬ_ПЕРВЫМ.md, «Чего в пакете нет»): они приходят в сервис
-- опубликованными версиями с content_hash. Но неизменяемый адрес
-- обязан вести человека к тексту, а не в пустоту — иначе принятое
-- нечем посмотреть.
--
-- Поэтому реестр хранит, ГДЕ текст опубликован. Пока это страницы
-- cmpas.ru: они существуют и открываются — проверено чтением
-- src/app/legal/terms/page.tsx и privacy/page.tsx соседнего репозитория.
ALTER TABLE legal_document_versions ADD COLUMN text_url text;

UPDATE legal_document_versions SET text_url = 'https://cmpas.ru/legal/terms'
  WHERE code = 'cmpas_terms';
UPDATE legal_document_versions SET text_url = 'https://cmpas.ru/legal/privacy'
  WHERE code = 'cmpas_privacy';
UPDATE legal_document_versions SET text_url = 'https://cmpas.ru/legal/pro'
  WHERE code = 'cmpas_professional';
UPDATE legal_document_versions SET text_url = 'https://cmpas.ru/legal/practice'
  WHERE code = 'cmpas_practice_terms';
UPDATE legal_document_versions SET text_url = 'https://cmpas.ru/legal/consent/marketing'
  WHERE code = 'cmpas_marketing_consent';
-- Особые условия ЗАПИСОК и МОМЕНТОВ, а также согласие клиента психолога
-- пока не опубликованы отдельной страницей: адрес остаётся NULL, и
-- страница честно скажет, что текст ещё не опубликован, вместо того
-- чтобы вести на чужой документ.
