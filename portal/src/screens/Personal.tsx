import { useState } from "react";
import { Shell, Panel } from "../components/Shell";
import { personal, PRODUCT_HOME, type ProductCode } from "@wording";
import type { Account, Email } from "../api/client";

/** Артборды K1 и K2 — личные данные и почты. */
export function Personal({
  profile, emails, returnTo, onSaveName, onAddEmail, onMakePrimary, onDeleteEmail, error,
}: {
  profile: Account;
  emails: Email[];
  returnTo: ProductCode | null;
  onSaveName?: (name: string) => void;
  onAddEmail?: (email: string) => void;
  onMakePrimary?: (id: string) => void;
  onDeleteEmail?: (id: string) => void;
  error?: string;
}) {
  const [name, setName] = useState(profile.display_name ?? "");
  const [newEmail, setNewEmail] = useState("");

  return (
    <Shell title={personal.title} returnTo={returnTo}>
      <section>
        <label htmlFor="display-name">{personal.nameLabel}</label>
        <input id="display-name" type="text" value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onSaveName?.(name)} />
        <p className="hint">{personal.nameHint}</p>
      </section>

      <section>
        <h2>{personal.emailLabel}</h2>
        <Panel><ul className="email-list">
          {emails.map((e) => (
            <li key={e.id} className="row">
              <span className="row-label">{e.email}</span>
              <span className="row-value muted">
                {e.is_primary ? personal.primary
                  : e.verified ? personal.verified : personal.unverified}
              </span>
              {/* Основную почту не удаляют, а меняют: у неё нет кнопки
                  «Удалить» вовсе, и отказ приходит от сервера, если
                  попробовать иначе. */}
              {!e.is_primary && e.verified && (
                <button type="button" className="secondary-button"
                  onClick={() => onMakePrimary?.(e.id)}>{personal.makePrimary}</button>
              )}
              {!e.is_primary && (
                <button type="button" className="secondary-button"
                  onClick={() => onDeleteEmail?.(e.id)}>{personal.remove}</button>
              )}
            </li>
          ))}
        </ul></Panel>
        {error && <p className="field-error" role="alert">{error}</p>}

        <div className="add-email">
          <label htmlFor="new-email">{personal.addEmail}</label>
          <input id="new-email" type="email" value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)} />
          <button type="button" className="secondary-button"
            onClick={() => onAddEmail?.(newEmail)}>{personal.addEmail}</button>
        </div>
      </section>

      {/* Граница: портал НЕ редактирует профиль продукта, а указывает дорогу. */}
      {/* Указатель в ПРАКТИКУ имеет смысл, только если дверь есть. */}
      {PRODUCT_HOME.practice && (
        <section className="pointer-block">
          <p className="hint">{personal.professional}</p>
          <a className="secondary-button" href="/return/practice">{personal.openPractice}</a>
        </section>
      )}
    </Shell>
  );
}
