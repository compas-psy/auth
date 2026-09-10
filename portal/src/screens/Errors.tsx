import { errors, type ServiceCode } from "@wording";

/**
 * Артборд C4 — вход временно недоступен.
 *
 * Человеческий текст, а не техническая ошибка: ECONNREFUSED на экране
 * это отказ объяснить, что произошло.
 */
export function SignInUnavailable({ service }: { service: ServiceCode }) {
  return (
    <div className="screen">
      <main className="card" role="alert">
        <h1>{errors.unavailableTitle}</h1>
        <p className="subtitle">{errors.unavailable}</p>
        {/* Отдельное состояние артборда: только для ЗАПИСОК (§6.3). */}
        {service === "zapiski" && <p className="hint">{errors.unavailableZapiski}</p>}
      </main>
    </div>
  );
}

/** Артборд C3 — аккаунт внешнего сервиса уже привязан к другому СИМПАС. */
export function IdentityTaken() {
  return (
    <div className="screen">
      <main className="card" role="alert">
        <h1>{errors.identityTakenTitle}</h1>
        {/* Отказ объясняется, а не констатируется: рядом с «нельзя»
            всегда стоит «а можно вот так» (задание 08 §6 п. 5). */}
        <p className="subtitle">{errors.identityTaken}</p>
      </main>
    </div>
  );
}
