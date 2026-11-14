import { HINT_ROLES } from "@/lib/bank/view";

/** The four hints in play order: Hint 1 (opening, least helpful) first, Hint 4 (most helpful) last. */
export function HintList({ hints }: { hints: readonly string[] }) {
  return (
    <ol className="wb__hints">
      {HINT_ROLES.map((r, i) => (
        <li key={r.n} className="wb__hint">
          <span className="wb__hint-title">{r.title}</span>
          <span className="wb__hint-text">{hints[i]?.trim() ? hints[i] : <em className="wb__empty">(empty)</em>}</span>
        </li>
      ))}
    </ol>
  );
}
