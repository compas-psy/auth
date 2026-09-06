import { useState, type FormEvent } from "react";
import { signIn, type ProductCode, type ProviderCode } from "@wording";

export interface SignInProps {
  service: ProductCode;
  /** Состав приходит с сервера (GET /v1/auth/methods), а не из сборки:
   *  приложение не должно показывать кнопку в пустоту. */
  providers: readonly ProviderCode[];
  termsVersion: string;
  platform?: "web" | "android" | "ios" | "desktop";
  onSubmitEmail: (email: string) => void;
  onProvider?: (provider: ProviderCode) => void;
}

/** Явная опечатка, а не проверка адреса на существование: она невозможна. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Артборды A1-A5 и A5н.
 *
 * Юридическая конструкция экрана (задание 08 §2.2):
 *   - обязательного чекбокса НЕТ. Акцепт — действием, содержательной
 *     кнопкой;
 *   - юридическая строка стоит под ОБОИМИ блоками, потому что относится
 *     и к кнопкам провайдеров, и к почте;
 *   - Политика упомянута БЕЗ глагола принятия: это информационный
 *     документ, его не принимают;
 *   - ссылки ведут на конкретную редакцию, а не на текущую.
 */
export function SignIn({
  service, providers, termsVersion, platform = "web", onSubmitEmail, onProvider,
}: SignInProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isMobile = platform === "android" || platform === "ios";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!looksLikeEmail(email)) {
      setError(signIn.emailInvalid);
      return;
    }
    setError(null);
    onSubmitEmail(email.trim());
  }

  return (
    <div className="screen">
      <main className="card">
        <p className="brand">{signIn.brand}</p>
        <h1>{signIn.title(service)}</h1>
        <p className="subtitle">{signIn.subtitle}</p>

        {/* Провайдеры первым блоком — решение учредителя от 06.09.2026.
            Почта вторым, БЕЗ свёртки. */}
        <div data-block="providers">
          {providers.length > 0 && (
            <div className="providers">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  data-provider={p}
                  className="provider-button"
                  onClick={() => onProvider?.(p)}
                >
                  <span className="provider-mark" aria-hidden="true" />
                  {signIn.providerButton(p)}
                </button>
              ))}
            </div>
          )}
          {/* Строка присутствует на всех артбордах входа, в том числе
              когда ни один провайдер не подключён: она объясняет, что
              именно узнаёт внешний сервис, и убирать её нельзя. */}
          <p className="provider-notice">{signIn.providerNotice}</p>
        </div>

        <div className="divider" aria-hidden="true">{signIn.divider}</div>

        <form data-block="email" onSubmit={submit} noValidate>
          <label htmlFor="signin-email">{signIn.emailLabel}</label>
          <input
            id="signin-email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-email-error" : undefined}
          />
          {error && <p className="field-error" id="signin-email-error" role="alert">{error}</p>}
          <button type="submit" className="primary-button">
            {isMobile ? signIn.emailSubmitMobile : signIn.emailSubmit}
          </button>
        </form>

        <p className="legal" data-testid="legal-line">
          Продолжая, вы принимаете{" "}
          <a href={`/legal/terms/${termsVersion}`}>{signIn.legalTermsLinkText}</a>
          {`, редакция ${termsVersion}. Как мы обращаемся с данными — в `}
          <a href={`/legal/privacy/${termsVersion}`}>{signIn.legalPrivacyLinkText}</a>.
        </p>
      </main>
    </div>
  );
}
