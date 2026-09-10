import { Shell, Row, Switch, Panel } from "../components/Shell";
import { security, PROVIDER_NAMES, type ProductCode } from "@wording";
import type { Account, Identity } from "../api/client";

/** Артборд L1 — безопасность. */
export function Security({
  profile, identities, productsMigrated, returnTo, onUnlink, notifyNewLogin, refusal,
}: {
  profile: Account;
  identities: Identity[];
  /** Продукты, уже переехавшие на единый вход. */
  productsMigrated: ProductCode[];
  returnTo: ProductCode | null;
  onUnlink?: (id: string) => void;
  notifyNewLogin?: boolean;
  /** Отказ от сервера — кадр, который обязан существовать (тест Т6). */
  refusal?: string;
}) {
  const zapiskiMigrated = productsMigrated.includes("zapiski");

  return (
    <Shell title={security.title} returnTo={returnTo}>
      <section>
        <h2>{security.methodsTitle}</h2>

        <Panel>
        <Row label={security.emailRow} value={profile.email} note={security.emailNote}>
          <a className="secondary-button" href="/account/personal">{security.change}</a>
        </Row>

        {identities.map((i) => (
          <Row key={i.id} label={PROVIDER_NAMES[i.provider]}
            value={security.linkedOn(formatDate(i.linked_at))}>
            <button type="button" className="secondary-button"
              onClick={() => onUnlink?.(i.id)}>{security.unlink}</button>
          </Row>
        ))}

        {/* «Ключ доступа», а не «passkey»: одна вещь — одно русское имя.
            Пояснение обязательно: без него человек не поймёт, что это. */}
        <Row label={security.passkeyRow} value={security.passkeyNotSet}
          note={security.passkeyHint}>
          <button type="button" className="secondary-button" disabled>
            {security.passkeySetup}
          </button>
        </Row>

        {/* Отказ приходит ОТ СЕРВЕРА, а не прячется в интерфейсе:
            кнопка не может быть просто неактивной (тест Т6). */}
        </Panel>
        {refusal && <p className="field-error" role="alert">{refusal}</p>}

        <button type="button" className="secondary-button" disabled>
          {security.linkAnother}
        </button>
      </section>

      <section>
        <Panel>
          <Switch id="notify-login" label={security.notifyNewLogin}
            checked={notifyNewLogin ?? false} />
        </Panel>
      </section>

      {/* Переходное состояние: показывается, пока ЗАПИСКИ не переехали. */}
      {!zapiskiMigrated && (
        <p className="hint" data-testid="zapiski-transitional">{security.zapiskiSeparate}</p>
      )}

      {/* УКАЗАТЕЛЬ БЕЗ ОРГАНОВ УПРАВЛЕНИЯ. Кнопка здесь означала бы, что
          аккаунт управляет паролем хранилища, а это прямое нарушение И-1:
          сервис не хранит, не принимает и не передаёт ключевой материал
          ЗАПИСОК ни в каком виде. */}
      <p className="hint" data-testid="vault-note">{security.vaultNote}</p>
    </Shell>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
