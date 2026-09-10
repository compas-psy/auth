import { Shell } from "../components/Shell";
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
        <ul className="document-list">
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
        </ul>
      </section>
    </Shell>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
}
