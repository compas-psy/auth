import { useState, type FormEvent } from "react";
import { signIn, PROVIDER_NAMES, type ServiceCode, type ProviderCode } from "@wording";

export interface SignInProps {
  service: ServiceCode;
  /** Состав приходит с сервера (GET /v1/auth/methods), а не из сборки:
   *  приложение не должно показывать кнопку в пустоту. */
  providers: readonly ProviderCode[];
  /**
   * Провайдер, которого назвал продукт: человек нажал у себя кружок с
   * его знаком. Мы его ВЫДЕЛЯЕМ и ставим первым — но экран
   * показываем целиком: юридическая строка на нём, и вход по
   * подтверждённой почте доступен всегда (И-5).
   */
  focusProvider?: ProviderCode;
  /**
   * Адрес, который человек набрал в продукте (штатный `login_hint`).
   * Подставляется в поле — и только: ничего не подтверждает, код или
   * ссылка всё равно уходят в этот ящик.
   *
   * Держит юридическую конструкцию: без него человек набирает адрес
   * дважды, продукт цепляется за свою форму входа, а учётная запись,
   * заведённая мимо нашего экрана, заведена мимо акцепта Соглашения.
   */
  emailHint?: string;
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
  service, providers, focusProvider, termsVersion, emailHint,
  platform = "web", onSubmitEmail, onProvider,
}: SignInProps) {
  /* Подсказка почты — адрес, который человек набрал в продукте. Она
     заполняет поле и на этом кончается: стереть и набрать другой можно
     в любой момент, а сам вход по-прежнему подтверждается письмом. */
  const [email, setEmail] = useState(emailHint ?? "");
  const [error, setError] = useState<string | null>(null);
  /** Ожидание гасит ТОЛЬКО нажатый знак: остальные остаются живыми. */
  const [pending, setPending] = useState<ProviderCode | null>(null);
  const isMobile = platform === "android" || platform === "ios";
  /* Названный продуктом провайдер встаёт первым: человек нажал его
     знак у себя и должен увидеть его знак здесь, а не искать в ряду. */
  const ordered = focusProvider && providers.includes(focusProvider)
    ? [focusProvider, ...providers.filter((p) => p !== focusProvider)]
    : providers;

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
        <p className="brand">
          <img src="/assets/simpas-mark.svg" alt="" width={28} height={28} />
          {signIn.brand}
        </p>
        <h1>{signIn.title(service)}</h1>

        {/* Провайдеры первым блоком — решение учредителя от 06.09.2026.
            Почта вторым, БЕЗ свёртки. */}
        <div data-block="providers">
          {providers.length > 0 && (
            <>
              <p className="providers-title">{signIn.providersTitle}</p>
              {/* Знаки в ряд, подпись под каждым — артборд A1. Кнопки в
                  столбик, стоявшие здесь раньше, макету не отвечали, а
                  место под знак было пустым квадратом: знаки всё это
                  время лежали в design/assets. */}
              <div className="providers">
                {ordered.map((p) => (
                  <span key={p} className="provider">
                    <button
                      type="button"
                      data-provider={p}
                      className="provider-disc"
                      data-focus={p === focusProvider ? "true" : undefined}
                      autoFocus={p === focusProvider || undefined}
                      aria-label={signIn.providerButton(p)}
                      aria-busy={pending === p ? true : undefined}
                      onClick={() => { setPending(p); onProvider?.(p); }}
                    />
                    <span className="provider-name">{PROVIDER_NAMES[p]}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          {/* Строка присутствует на всех артбордах входа, в том числе
              когда ни один провайдер не подключён: она объясняет, что
              именно узнаёт внешний сервис, и убирать её нельзя. */}
          <p className="provider-notice">{signIn.providerNotice}</p>
        </div>

        <div className="divider" aria-hidden="true"><span>{signIn.divider}</span></div>

        <form data-block="email" onSubmit={submit} noValidate>
          <label htmlFor="signin-email">{signIn.emailLabel}</label>
          <input
            id="signin-email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
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
          {". Как мы обращаемся с данными — в "}
          <a href={`/legal/privacy/${termsVersion}`}>{signIn.legalPrivacyLinkText}</a>.
        </p>
      </main>
    </div>
  );
}
