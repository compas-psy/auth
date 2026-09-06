import { useState } from "react";
import { Shell } from "../components/Shell";
import { devices, endOthers, type ProductCode } from "@wording";
import type { Session } from "../api/client";

const PLATFORM_NAMES: Record<string, string> = {
  windows: "Windows", macos: "macOS", linux: "Linux",
  android: "Android", ios: "iOS",
};
const CLIENT_NAMES: Record<string, string> = {
  chrome: "Chrome", safari: "Safari", firefox: "Firefox",
  edge: "Edge", opera: "Opera", yandex: "Яндекс Браузер",
  app: "приложение",
};

/**
 * Артборды L2 и L3 — устройства и сеансы.
 *
 * Решение П-2 от 06.09.2026: строка называет огрублённое семейство
 * платформы и клиента. IP-адреса и точного устройства здесь нет —
 * они не хранятся, и на экране прямо написано, почему.
 */
export function Devices({
  sessions, returnTo, onRevoke, onRevokeOthers,
}: {
  sessions: Session[];
  returnTo: ProductCode;
  onRevoke?: (id: string) => void;
  onRevokeOthers?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const current = sessions.filter((s) => s.current);
  const others = sessions.filter((s) => !s.current);

  return (
    <Shell title={devices.title} returnTo={returnTo}>
      {current.length > 0 && (
        <section>
          <h2>{devices.thisDevice}</h2>
          {current.map((s) => (
            <div key={s.id} className="row">
              <span className="row-label">{describe(s)}</span>
              <span className="row-value muted">{devices.lastSeen(formatDate(s.last_seen_at))}</span>
              {/* У текущего сеанса кнопки «Завершить» нет: завершить
                  себя из этого списка — это выход, и он в другом месте. */}
            </div>
          ))}
        </section>
      )}

      {others.length > 0 && (
        <section>
          <h2>{devices.others}</h2>
          {others.map((s) => (
            <div key={s.id} className="row">
              <span className="row-label">{describe(s)}</span>
              <span className="row-value muted">{devices.lastSeen(formatDate(s.last_seen_at))}</span>
              <button type="button" className="secondary-button"
                onClick={() => onRevoke?.(s.id)}>{devices.end}</button>
            </div>
          ))}
        </section>
      )}

      {others.length > 0 && !confirming && (
        <button type="button" className="secondary-button" onClick={() => setConfirming(true)}>
          {devices.endOthers}
        </button>
      )}

      {/* Артборд L3 — подтверждение. */}
      {confirming && (
        <div className="confirm" role="dialog" aria-label={endOthers.title}>
          <h2>{endOthers.title}</h2>
          <p>{endOthers.body}</p>
          <button type="button" className="primary-button"
            onClick={() => { setConfirming(false); onRevokeOthers?.(); }}>
            {endOthers.confirm}
          </button>
          <button type="button" className="secondary-button"
            onClick={() => setConfirming(false)}>{endOthers.cancel}</button>
        </div>
      )}

      {/* Обязательная строка, не украшение: она объясняет, ПОЧЕМУ экран
          беднее, чем у крупных сервисов, и превращает ограничение
          в аргумент. */}
      <p className="hint">{devices.noIpNote}</p>
    </Shell>
  );
}

function describe(s: Session): string {
  const platform = s.platform ? PLATFORM_NAMES[s.platform] ?? s.platform : null;
  const client = s.client ? CLIENT_NAMES[s.client] ?? s.client : null;
  if (platform && client) return `${platform} · ${client}`;
  return platform ?? client ?? devices.unknownDevice;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
