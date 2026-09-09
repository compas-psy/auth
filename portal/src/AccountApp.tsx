import { useEffect, useState } from "react";
import { Account } from "./screens/Account";
import { Personal } from "./screens/Personal";
import { Security } from "./screens/Security";
import { Devices } from "./screens/Devices";
import { Communications } from "./screens/Communications";
import { Privacy } from "./screens/Privacy";
import { api, ApiError, type Account as AccountData, type Email, type Identity,
  type Session, type Communication, type AcceptedDocument } from "./api/client";
import { security, errors } from "@wording";
import type { ProductCode } from "@wording";
import { beginAuthorization, completeCallback, currentToken } from "./auth/oidc";

/**
 * Портал аккаунта. Ходит только в публичное API v1 — тем же, которым
 * работают продукты. Внутреннего пути не существует.
 */
export function AccountApp({ screen, returnTo }: { screen: string; returnTo: ProductCode }) {
  const [profile, setProfile] = useState<AccountData | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [documents, setDocuments] = useState<AcceptedDocument[]>([]);
  const [refusal, setRefusal] = useState<string | undefined>();
  /** Отказ загрузки: пустой экран без объяснения — не состояние. */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        // Возврат от нашего же экрана входа: меняем код на ключ доступа.
        const params = new URLSearchParams(location.search);
        if (params.has("code") || params.has("error")) {
          const returnTo = await completeCallback(params);
          history.replaceState(null, "", returnTo);
        }
        // Ключа нет — человек не вошёл. Уводим на вход, а не показываем
        // пустоту: до этой правки здесь навсегда оставался пустой div.
        if (!currentToken()) {
          location.assign(await beginAuthorization(location.pathname + location.search));
          return;
        }
      } catch {
        setFailed(true);
        return;
      }

      try {
        setProfile(await api.getAccount());
        if (screen === "AccountPersonal") setEmails((await api.listEmails()).emails);
        if (screen === "AccountSecurity") setIdentities((await api.listIdentities()).identities);
        if (screen === "AccountDevices") setSessions((await api.listSessions()).sessions);
        if (screen === "AccountCommunications" || screen === "AccountPrivacy") {
          const c = await api.getConsents();
          setCommunications(c.communications);
          setDocuments(c.accepted_documents);
        }
      } catch {
        // Ключ протух между переходами — начинаем вход заново, один раз.
        if (!currentToken()) {
          location.assign(await beginAuthorization(location.pathname));
          return;
        }
        setFailed(true);
      }
    })();
  }, [screen]);

  if (failed) {
    return (
      <div className="screen">
        <main className="card" role="alert">
          <h1>{errors.unavailableTitle}</h1>
          <p className="subtitle">{errors.unavailable}</p>
        </main>
      </div>
    );
  }
  if (!profile) return <div className="portal" aria-busy="true" />;

  /**
   * Отказ приходит ОТ СЕРВЕРА и показывается человеку человеческим
   * текстом из реестра формулировок. Машинный код из API на экран
   * не попадает.
   */
  async function guarded(fn: () => Promise<unknown>): Promise<void> {
    try {
      setRefusal(undefined);
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "last_login_method") {
        setRefusal(security.lastMethodRefusal);
        return;
      }
      throw e;
    }
  }

  switch (screen) {
    case "AccountPersonal":
      return <Personal profile={profile} emails={emails} returnTo={returnTo}
        onSaveName={(n) => void api.setDisplayName(n || null)}
        onAddEmail={(e) => void api.addEmail(e)}
        onMakePrimary={(id) => void api.makeEmailPrimary(id)}
        onDeleteEmail={(id) => void guarded(() => api.deleteEmail(id))}
        error={refusal} />;
    case "AccountSecurity":
      return <Security profile={profile} identities={identities}
        productsMigrated={profile.products} returnTo={returnTo}
        onUnlink={(id) => void guarded(() => api.unlinkIdentity(id))}
        refusal={refusal} />;
    case "AccountDevices":
      return <Devices sessions={sessions} returnTo={returnTo}
        onRevoke={(id) => void api.revokeSession(id)}
        onRevokeOthers={() => void api.revokeOtherSessions()} />;
    case "AccountCommunications":
      return <Communications communications={communications} termsVersion="0.9"
        returnTo={returnTo}
        onToggle={(channel, next) => void api.setConsent({
          document_code: "cmpas_marketing_consent", version: "0.9", channel,
          status: next ? "granted" : "revoked",
          action: `switch_marketing_${channel}`,
        }).then((s) => setCommunications(s.communications))}
        onRevokeAll={() => void api.revokeAllMarketing()
          .then((s) => setCommunications(s.communications))} />;
    case "AccountPrivacy":
      return <Privacy documents={documents} returnTo={returnTo} />;
    default:
      return <Account profile={profile} returnTo={returnTo}
        products={profile.products.map((code) => ({ code, since: "" }))} />;
  }
}
