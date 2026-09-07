-- 0012_sub_immutable.sql — sub неизменен, и это проверяет база.
--
-- `sub` в токене — это accounts.id. Для продукта он первичен: у ПРАКТИКИ
-- он лежит в Account.providerAccountId и служит связью с человеком.
-- Изменись он у одного человека — ПРАКТИКА заведёт вторую строку
-- Account, а при allowDangerousEmailAccountLinking привяжет её к тому же
-- пользователю по почте и расхождения НЕ ЗАМЕТИТ (issue
-- compas-psy/cmpas.ru#132, вопрос агента от 07.09.2026).
--
-- До этой правки неизменность была фактической, а не обеспеченной:
-- сменить id мешал лишь внешний ключ из account_emails, и у записи без
-- дочерних строк UPDATE проходил. Обещание продукту так держать нельзя.
--
-- Правка аддитивна: существующие строки не трогаются, запрет касается
-- только попыток изменить идентификатор.

CREATE OR REPLACE FUNCTION accounts_id_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION
      'sub неизменен: идентификатор учётной записи менять нельзя (было %, стало %)',
      OLD.id, NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_id_immutable ON accounts;
CREATE TRIGGER accounts_id_immutable
  BEFORE UPDATE OF id ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_id_is_immutable();
