import { useState } from "react";
import { Shell, Switch } from "../components/Shell";
import { communications, type ProductCode } from "@wording";
import type { Communication } from "../api/client";

const CHANNEL_LABELS = {
  email: communications.channelEmail,
  push: communications.channelPush,
} as const;

/**
 * Артборды M1, M2 и M3 — коммуникации.
 *
 * Все переключатели выключены — это единственное исходное состояние
 * (юрпакет §3.1). Кадра «как выглядит включённым по умолчанию»
 * не существует.
 *
 * SMS и звонков как канала нет (задание 08 §1.3).
 */
export function Communications({
  communications: channels, termsVersion, returnTo, onToggle, onRevokeAll,
}: {
  communications: Communication[];
  termsVersion: string;
  returnTo: ProductCode;
  onToggle?: (channel: "email" | "push", next: boolean) => void;
  onRevokeAll?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <Shell title={communications.title} returnTo={returnTo}>
      <section>
        <h2>{communications.marketingTitle}</h2>
        {channels.map((c) => (
          <Switch
            key={c.channel}
            id={`ch-${c.channel}`}
            label={CHANNEL_LABELS[c.channel]}
            checked={c.status === "granted"}
            onChange={(next) => onToggle?.(c.channel, next)}
          />
        ))}
        {/* Включение канала — это дача согласия, поэтому рядом стоит
            ссылка на текст, как на экране входа (задание 08 §2.4).
            Номер редакции не называется: его нет в макете, а ссылка
            ведёт на конкретную редакцию. */}
        <p className="hint">
          {communications.consentReference(termsVersion)}{" "}
          <a href={`/legal/marketing-consent/${termsVersion}`}>Посмотреть текст</a>
        </p>
      </section>

      {/* Разделение сервисных и рекламных сообщений — прямым текстом. */}
      <p className="hint">{communications.serviceNote}</p>

      {/* «Отключить всю рекламу» присутствует ВСЕГДА — прямое требование §9. */}
      {!confirming && (
        <button type="button" className="secondary-button" onClick={() => setConfirming(true)}>
          {communications.revokeAll}
        </button>
      )}

      {confirming && (
        <div className="confirm" role="dialog" aria-label={communications.confirmTitle}>
          <h2>{communications.confirmTitle}</h2>
          <p>{communications.confirmBody}</p>
          <p className="hint">{communications.confirmKeep}</p>
          <button type="button" className="primary-button"
            onClick={() => { setConfirming(false); onRevokeAll?.(); }}>
            {communications.confirmYes}
          </button>
          <button type="button" className="secondary-button"
            onClick={() => setConfirming(false)}>{communications.confirmNo}</button>
        </div>
      )}
    </Shell>
  );
}
