import { useRef, useState } from "react";
import { checkEmail, enterCode } from "@wording";

export interface EnterCodeProps {
  maskedEmail: string;
  secondsLeft: number;
  attemptsLeft: number;
  burned?: boolean;
  invalid?: boolean;
  onSubmit: (code: string) => void;
  onResend: () => void;
}

const LENGTH = 6;

/**
 * Артборд A6н — ввод кода на мобильном. Заменяет B2 на мобильном;
 * на вебе B2 остаётся как есть.
 *
 * Браузер здесь не открывается ни разу: в этом весь смысл кода вместо
 * ссылки (12_NATIVE_AUTH.md §2.1).
 */
export function EnterCode({
  maskedEmail, secondsLeft, attemptsLeft, burned, invalid, onSubmit, onResend,
}: EnterCodeProps) {
  const [digits, setDigits] = useState<string[]>(Array(LENGTH).fill(""));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const waiting = secondsLeft > 0;

  function setDigit(index: number, value: string): void {
    const clean = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    if (clean && index < LENGTH - 1) refs.current[index + 1]?.focus();
    const code = next.join("");
    if (code.length === LENGTH && !next.includes("")) onSubmit(code);
  }

  return (
    <div className="screen">
      <main className="card">
        <h1>{enterCode.title}</h1>
        <p className="subtitle">{enterCode.sent(maskedEmail)}</p>
        <p className="hint">{enterCode.validity}</p>

        <div className="code-cells">
          {digits.map((d, i) => (
            <input
              key={i}
              data-code-cell={i}
              ref={(el) => { refs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={1}
              value={d}
              disabled={burned}
              aria-label={`Цифра ${i + 1}`}
              onChange={(e) => setDigit(i, e.target.value)}
            />
          ))}
        </div>

        {burned
          ? <p className="field-error" role="alert">{enterCode.burned}</p>
          : invalid
            ? <p className="field-error" role="alert">{enterCode.invalid}</p>
            : null}
        {!burned && <p className="muted">{enterCode.attemptsLeft(attemptsLeft)}</p>}

        <button type="button" className="secondary-button" onClick={onResend} disabled={waiting}>
          {waiting ? checkEmail.resendIn(secondsLeft) : checkEmail.resend}
        </button>
      </main>
    </div>
  );
}
