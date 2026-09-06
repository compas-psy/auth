-- 0001_identity.sql — схема личности.
-- Учётная запись СИМПАС это человек, а не пользователь продукта
-- (02_SIMPASID.md §4.1). Ни пароля, ни телефона, ни роли, ни подписки:
-- их отсутствие обеспечено И-2 и проверяется schema.invariants.test.ts.

CREATE TABLE accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','deletion_requested','deleted')),
  display_name          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deletion_requested_at timestamptz,
  deleted_at            timestamptz
);

-- Несколько почт: смена почты не должна означать потерю аккаунта
-- и данных (02_SIMPASID.md §4.2).
CREATE TABLE account_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       text NOT NULL,
  verified_at timestamptz,
  is_primary  boolean NOT NULL DEFAULT false,
  added_at    timestamptz NOT NULL DEFAULT now()
);

-- Уникальность без учёта регистра — как уже сделано в ЗАПИСКАХ
-- (users_email_lower_key). Адрес при этом хранится как введён:
-- показывать человеку его почту в чужом регистре незачем.
CREATE UNIQUE INDEX account_emails_lower_key ON account_emails (lower(email));
CREATE UNIQUE INDEX account_emails_one_primary
  ON account_emails (account_id) WHERE is_primary;
CREATE INDEX account_emails_account_idx ON account_emails (account_id);

-- Токены провайдера здесь не хранятся (02_SIMPASID.md §2.8 п. 4).
-- email_at_link — почта, которую отдал провайдер в момент привязки,
-- для разбора спорных случаев.
CREATE TABLE identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('yandex','tid','sberid','vkid')),
  subject       text NOT NULL,
  email_at_link text,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
-- У-2: один аккаунт провайдера — одна учётная запись.
CREATE UNIQUE INDEX identities_provider_subject_key ON identities (provider, subject);
CREATE INDEX identities_account_idx ON identities (account_id);

-- Единственный мост между личностью и данными продукта. Смысл — в двух
-- операциях: «показать всё про человека» и «удалить всё про человека».
CREATE TABLE product_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product         text NOT NULL CHECK (product IN ('practice','zapiski','moments')),
  product_user_id text NOT NULL,
  linked_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_links_product_user_key ON product_links (product, product_user_id);
CREATE UNIQUE INDEX product_links_account_product_key ON product_links (account_id, product);
