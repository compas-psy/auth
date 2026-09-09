import { useEffect, useState } from "react";
import { SignIn } from "./screens/SignIn";
import { CheckEmail } from "./screens/CheckEmail";
import { EnterCode } from "./screens/EnterCode";
import { EmailRequired } from "./screens/EmailRequired";
import { SignInUnavailable, IdentityTaken } from "./screens/Errors";
import { AccountApp } from "./AccountApp";
import type { ServiceCode, ProductCode, ProviderCode } from "@wording";

interface State {
  screen?: string;
  uid?: string;
  service?: ServiceCode;
  providers?: ProviderCode[];
  termsVersion?: string;
  platform?: "web" | "android" | "ios";
  provider?: ProviderCode;
}

/** Скрывает адрес частично: t…v@ya.ru. Так в источнике (§7.2). */
function mask(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  if (name.length <= 2) return `${name}@${domain}`;
  return `${name[0]}…${name[name.length - 1]}@${domain}`;
}

export function App({ state }: { state: State }) {
  const [screen, setScreen] = useState(state.screen ?? "SignIn");
  const [email, setEmail] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  const isMobile = state.platform === "android" || state.platform === "ios";

  async function submitEmail(value: string): Promise<void> {
    setEmail(value);
    try {
      await fetch(`/interaction/${state.uid}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      setSecondsLeft(60);
      setScreen(isMobile ? "EnterCode" : "CheckEmail");
    } catch {
      setScreen("Unavailable");
    }
  }

  /**
   * Экраны, которым нужен НАСТОЯЩИЙ продукт: ссылка «вернуться» ведёт
   * в продукт, а в аккаунт возвращаться неоткуда — человек уже в нём.
   *
   * ОТКРЫТЫЙ ВОПРОС к учредителю: куда ведёт «вернуться» тому, кто
   * набрал auth.cmpas.ru руками и ни из какого продукта не приходил.
   * Пока — в ПРАКТИКУ, как было до появления заголовка про аккаунт:
   * это поведение не меняется этой правкой, а лишь названо вслух.
   */
  function productOf(service: ServiceCode | undefined): ProductCode {
    return service && service !== "account" ? service : "practice";
  }

  if (screen.startsWith("Account")) {
    return <AccountApp screen={screen} returnTo={productOf(state.service)} />;
  }

  switch (screen) {
    case "CheckEmail":
      return (
        <CheckEmail maskedEmail={mask(email)} secondsLeft={secondsLeft}
          onResend={() => submitEmail(email)} onChange={() => setScreen("SignIn")} />
      );
    case "EnterCode":
      return (
        <EnterCode maskedEmail={mask(email)} secondsLeft={secondsLeft} attemptsLeft={5}
          onSubmit={() => undefined} onResend={() => submitEmail(email)} />
      );
    case "EmailRequired":
      return <EmailRequired provider={state.provider ?? "yandex"} onSubmit={submitEmail} />;
    case "IdentityTaken":
      return <IdentityTaken />;
    case "Unavailable":
    case "LinkExpired":
      return <SignInUnavailable service={productOf(state.service)} />;
    default:
      return (
        <SignIn
          service={state.service ?? "practice"}
          providers={state.providers ?? []}
          termsVersion={state.termsVersion ?? "0.9"}
          platform={state.platform ?? "web"}
          onSubmitEmail={submitEmail}
          onProvider={(provider) => {
            // Уходим к провайдеру через свой маршрут: он выпускает
            // одноразовый state и знает, к какой попытке входа
            // возвращать. Прямая ссылка на провайдера этого не умеет.
            window.location.assign(`/interaction/${state.uid}/provider/${provider}`);
          }}
        />
      );
  }
}
