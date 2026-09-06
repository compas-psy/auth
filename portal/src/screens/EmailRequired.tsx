import { useState, type FormEvent } from "react";
import { emailRequired, signIn, type ProviderCode } from "@wording";

export interface EmailRequiredProps {
  provider: ProviderCode;
  onSubmit: (email: string) => void;
}

/**
 * Артборды C2 и A7н — внешний сервис не отдал подтверждённую почту.
 *
 * Экран существует потому, что И-5 требует подтверждённой почты у каждой
 * учётной записи, а отдаёт ли её каждый провайдер — не проверено.
 */
export function EmailRequired({ provider, onSubmit }: EmailRequiredProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(signIn.emailInvalid);
      return;
    }
    onSubmit(email.trim());
  }

  return (
    <div className="screen">
      <main className="card">
        <h1>{emailRequired.title}</h1>
        <p className="subtitle">{emailRequired.explain(provider)}</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="required-email">{signIn.emailLabel}</label>
          <input
            id="required-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
          />
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="submit" className="primary-button">{emailRequired.submit}</button>
        </form>
      </main>
    </div>
  );
}
