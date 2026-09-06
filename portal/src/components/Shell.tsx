import type { ReactNode } from "react";
import { account, type ProductCode } from "@wording";

/**
 * Оболочка экранов портала.
 *
 * Путь возврата в продукт есть на КАЖДОМ экране: человек пришёл сюда
 * из продукта и на другой домен, и обратная дорога не должна
 * восстанавливаться кнопкой «назад».
 */
export function Shell({
  title, returnTo, children,
}: { title: string; returnTo: ProductCode; children: ReactNode }) {
  return (
    <div className="portal">
      <header className="portal-head">
        <a className="back-link" href={`/return/${returnTo}`}>
          ← {account.backTo(returnTo)}
        </a>
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
