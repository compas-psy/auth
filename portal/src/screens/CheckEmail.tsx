import { checkEmail } from "@wording";

export interface CheckEmailProps {
  /** Адрес показывается частично скрытым — так в источнике (§7.2). */
  maskedEmail: string;
  secondsLeft: number;
  onResend: () => void;
  onChange: () => void;
}

/** Артборд B2. Текст дословно из 02_SIMPASID.md §7.2, изменений не вносить. */
export function CheckEmail({ maskedEmail, secondsLeft, onResend, onChange }: CheckEmailProps) {
  const waiting = secondsLeft > 0;
  return (
    <div className="screen">
      <main className="card">
        <h1>{checkEmail.title}</h1>
        <p className="subtitle">{checkEmail.sent(maskedEmail)}</p>
        <p className="hint">{checkEmail.validity}</p>

        <button
          type="button"
          className="primary-button"
          onClick={onResend}
          disabled={waiting}
        >
          {waiting ? checkEmail.resendIn(secondsLeft) : checkEmail.resend}
        </button>

        <p className="hint" style={{ marginTop: 24 }}>{checkEmail.noLetter}</p>
        <button type="button" className="secondary-button" onClick={onChange}>
          {checkEmail.changeAddress}
        </button>
      </main>
    </div>
  );
}
