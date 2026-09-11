import { Shell, Panel } from "../components/Shell";
import { privacy, type ProductCode } from "@wording";
import type { AcceptedDocument } from "../api/client";

/**
 * Артборд N1 — данные и приватность.
 *
 * Портал НЕ дублирует экран «Мои данные», а ведёт на него: выгрузка и
 * удаление — отдельный контур (05_CONSENT_PDN.md §7.2), и его место
 * в Э4, а не здесь.
 */
export function Privacy({
  documents, returnTo,
}: { documents: AcceptedDocument[]; returnTo: ProductCode | null }) {
  return (
    <Shell title={privacy.title} returnTo={returnTo}>
      <p className="subtitle">{privacy.body}</p>
      <a className="secondary-button" href="/account/my-data">{privacy.myData}</a>

      <section>
        <h2>{privacy.acceptedTitle}</h2>
        <Panel><ul className="document-list">
          {documents.map((d) => (
            <li key={`${d.document_code}:${d.version}`} className="row">
              <span className="row-label">
                {privacy.documentVersion(d.title, d.version)}
              </span>
              <span className="row-value muted">
                {privacy.acceptedOn(formatDate(d.accepted_at))}
              </span>
              {/* Ссылка ведёт на ТУ редакцию, которую человек принял,
                  по неизменяемому адресу, а не на текущую. */}
              <a className="secondary-button" href={d.url}>{privacy.viewText}</a>
            </li>
          ))}
        </ul></Panel>
      </section>

      {/* Реестры и Политика — на нашем домене, а не в продукте.
          Центральный документ Экосистемы не может открываться с
          cmpas.ru (13_LEGAL_CONSENT_CENTER_AUTH.md §4). */}
      <section>
        <p className="section-label">{privacy.referencesTitle}</p>
        <Panel><ul className="document-list">
          <li className="row">
            <span className="row-label">{privacy.policyLink}</span>
            <span className="row-value muted">{privacy.policyHint}</span>
            <a className="secondary-button" href="/legal/privacy">{privacy.openReference}</a>
          </li>
          <li className="row">
            <span className="row-label">{privacy.servicesLink}</span>
            <a className="secondary-button" href="/legal/services">{privacy.openReference}</a>
          </li>
          <li className="row">
            <span className="row-label">{privacy.processorsLink}</span>
            <a className="secondary-button" href="/legal/processors">{privacy.openReference}</a>
          </li>
        </ul></Panel>
      </section>
    </Shell>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
}
