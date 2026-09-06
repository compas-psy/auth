-- Замер до и после подключения единого входа (Задача 17, шаг 1 и шаг 4).
--
-- Схема проверена чтением server/migrations/0001_accounts.sql репозитория
-- ЗАПИСОК: таблица sessions, колонка revoked_at.
--
-- Оба запроса выполняются ДО изменений и ПОСЛЕ. Числа обязаны совпасть.
-- Не совпали — откат, а не разбор на живых людях.

-- 1. Сколько действующих сеансов
SELECT count(*) AS active_sessions
FROM sessions
WHERE revoked_at IS NULL AND expires_at > now();

-- 2. Контрольная сумма состава: ловит подмену, которую не поймает счёт
SELECT md5(string_agg(id::text, ',' ORDER BY id)) AS fingerprint
FROM sessions
WHERE revoked_at IS NULL;

-- 3. Сколько людей затронуто — для оценки цены ошибки
SELECT count(*) AS active_users
FROM users
WHERE deleted_at IS NULL;
