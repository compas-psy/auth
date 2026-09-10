import { Shell, Panel } from "../components/Shell";
import { account, PRODUCT_NAMES, PRODUCT_HOME, type ProductCode } from "@wording";
import type { Account as AccountData } from "../api/client";

export interface ProductRow {
  code: ProductCode;
  since: string;
}

/** Артборд J1 — обзор. */
export function Account({
  profile, products, returnTo,
}: { profile: AccountData; products: ProductRow[]; returnTo: ProductCode | null }) {
  const connected = new Map(products.map((p) => [p.code, p]));
  /**
   * Перечень продуктов берётся ИЗ РЕЕСТРА ИМЁН, а не пишется здесь.
   *
   * Он был вписан руками тремя строками, и ШАГИ в кабинете не
   * показывались вовсе: продукт добавили миграцией и словарём, а этот
   * список остался прежним. Отказа не было — просто продукта не
   * существовало для человека.
   */
  const all = Object.keys(PRODUCT_NAMES) as ProductCode[];

  return (
    <Shell title={account.title} returnTo={returnTo} atRoot>
      <p className="subtitle">{account.subtitle}</p>
      <p className="muted">{profile.email}</p>

      <nav className="card-grid">
        <a className="nav-card" href="/account/personal">
          <span className="nav-card-title">{account.cards.personal.title}</span>
          <span className="nav-card-hint">{account.cards.personal.hint}</span>
        </a>
        <a className="nav-card" href="/account/security">
          <span className="nav-card-title">{account.cards.security.title}</span>
          <span className="nav-card-hint">{account.cards.security.hint}</span>
        </a>
        <a className="nav-card" href="/account/communications">
          <span className="nav-card-title">{account.cards.communications.title}</span>
          <span className="nav-card-hint">{account.cards.communications.hint}</span>
        </a>
        <a className="nav-card" href="/account/privacy">
          <span className="nav-card-title">{account.cards.privacy.title}</span>
          <span className="nav-card-hint">{account.cards.privacy.hint}</span>
        </a>
      </nav>

      <section>
        <p className="section-label">{account.productsTitle}</p>
        {/* Перечень формируется из данных, а не пишется в вёрстке.
            «Не подключены» пишется явно — то же правило, что тест Т11. */}
        <Panel><ul className="product-list">
          {all.map((code) => {
            const row = connected.get(code);
            return (
              <li key={code} className="row">
                <span className="row-main">
                  <span className="row-label">{PRODUCT_NAMES[code]}</span>
                  <span className="row-value">
                    {row ? account.productSince(row.since) : account.productNotConnected}
                  </span>
                </span>
                {/* Кнопка только там, где дверь есть: у МОМЕНТОВ и ШАГОВ
                    адреса пока нет, и ссылка вела бы в пустоту. */}
                {row && PRODUCT_HOME[code] && (
                  <a className="secondary-button" href={`/return/${code}`}>{account.open}</a>
                )}
              </li>
            );
          })}
        </ul></Panel>
      </section>
    </Shell>
  );
}
