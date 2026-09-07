-- 0011_product_steps.sql — ШАГИ как четвёртый продукт экосистемы.
--
-- Ограничение расширяется, а НЕ снимается: опечатка в коде продукта
-- по-прежнему отвергается базой, иначе рядом с тремя продуктами тихо
-- завелась бы четвёртая сущность с чужим именем.
--
-- Правка аддитивна: существующие строки под новое ограничение подходят
-- все до одной, переписывать нечего.

ALTER TABLE product_links DROP CONSTRAINT IF EXISTS product_links_product_check;
ALTER TABLE product_links
  ADD CONSTRAINT product_links_product_check
  CHECK (product IN ('practice','zapiski','moments','steps'));

ALTER TABLE oidc_clients DROP CONSTRAINT IF EXISTS oidc_clients_product_check;
ALTER TABLE oidc_clients
  ADD CONSTRAINT oidc_clients_product_check
  CHECK (product IN ('practice','zapiski','moments','steps'));
