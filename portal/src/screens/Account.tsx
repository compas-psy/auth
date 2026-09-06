import { Shell } from "../components/Shell";
import { account, PRODUCT_NAMES, type ProductCode } from "@wording";
import type { Account as AccountData } from "../api/client";

export interface ProductRow {
  code: ProductCode;
  since: string;
}

/** Артборд J1 — обзор. */
export function Account({
  profile, products, returnTo,
}: { profile: AccountData; products: ProductRow[]; returnTo: ProductCode }) {
  const connected = new Map(products.map((p) => [p.code, p]));
  const all: ProductCode[] = ["practice", "zapiski", "moments"];

  return (
    <Shell title={account.title} returnTo={returnTo}>
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
        <h2>{account.productsTitle}</h2>
        {/* Перечень формируется из данных, а не пишется в вёрстке.
            «Не подключены» пишется явно — то же правило, что тест Т11. */}
        <ul className="product-list">
          {all.map((code) => {
            const row = connected.get(code);
            return (
              <li key={code} className="row">
                <span className="row-label">{PRODUCT_NAMES[code]}</span>
                {row ? (
                  <>
                    <span className="row-value">{account.productSince(row.since)}</span>
                    <a className="secondary-button" href={`/return/${code}`}>{account.open}</a>
                  </>
                ) : (
                  <span className="row-value muted">{account.productNotConnected}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Shell>
  );
}
