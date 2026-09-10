import type { ReactNode } from "react";
import { account, PRODUCT_HOME, type ProductCode } from "@wording";

/**
 * Оболочка экранов кабинета.
 *
 * Путь назад есть на КАЖДОМ экране — «портал не ловушка»
 * (09_ACCOUNT_DESIGN_ADDENDUM.md §168). Но КУДА назад, зависит от того,
 * как человек сюда попал:
 *
 *   пришёл из продукта  → «Вернуться в ПРАКТИКУ», в сам продукт;
 *   пришёл сам          → в обзор аккаунта: продукта, из которого он
 *                         якобы пришёл, не существует, и звать его
 *                         «обратно» туда — выдумка про его путь;
 *   обзор аккаунта      → назад некуда, он и есть начало.
 *
 * Продукт без известного адреса ссылкой не становится: обещанная и
 * несуществующая дверь хуже отсутствующей.
 */
export function Shell({
  title, returnTo, atRoot, children,
}: {
  title: string;
  returnTo?: ProductCode | null;
  /** Обзор аккаунта: он сам и есть начало, ссылка на себя не нужна. */
  atRoot?: boolean;
  children: ReactNode;
}) {
  const home = returnTo ? PRODUCT_HOME[returnTo] : null;
  return (
    <div className="portal">
      <header className="portal-head">
        {returnTo && home ? (
          <a className="back-link" href={`/return/${returnTo}`}>
            ← {account.backTo(returnTo)}
          </a>
        ) : atRoot ? null : (
          <a className="back-link" href="/account">← {account.title}</a>
        )}
      </header>
      <main className="portal-main">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function Row({
  label, value, note, children, testId,
}: {
  label: string; value?: ReactNode; note?: string;
  children?: ReactNode; testId?: string;
}) {
  return (
    <div className="row" data-testid={testId}>
      <div className="row-main">
        <span className="row-label">{label}</span>
        {value !== undefined && <span className="row-value">{value}</span>}
      </div>
      {note && <p className="row-note">{note}</p>}
      {children && <div className="row-actions">{children}</div>}
    </div>
  );
}

/**
 * Переключатель согласия. Выключен по умолчанию — единственное
 * исходное состояние (юрпакет §3.1). Предустановленным быть не может.
 */
export function Switch({
  label, checked, onChange, id,
}: { label: string; checked: boolean; onChange?: (v: boolean) => void; id: string }) {
  return (
    <div className="switch-row">
      <span id={`${id}-label`}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        className={checked ? "switch switch-on" : "switch"}
        onClick={() => onChange?.(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}
