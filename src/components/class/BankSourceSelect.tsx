export type BankSource = "current" | "independent";
/** The Current Bank (saved in this browser) is always the default. Nothing remembers or switches the choice automatically. */
export const DEFAULT_BANK_SOURCE: BankSource = "current";

/** "Which bank?": two clearly labelled choices for the next Pair Game. */
export function BankSourceSelect({ source, currentCount, independentCount, onChange }: {
  source: BankSource;
  /** Questions in the browser's saved bank, when one is loaded. */
  currentCount: number | null;
  /** Approved words loaded from the independent bank, once the teacher has chosen it. */
  independentCount: number | null;
  onChange: (next: BankSource) => void;
}) {
  return (
    <fieldset className="bankhost__source">
      <legend className="field__label">Which bank?</legend>
      <label className={`bankhost__choice${source === "current" ? " bankhost__choice--on" : ""}`}>
        <input type="radio" name="bank-source" checked={source === "current"} onChange={() => onChange("current")} />
        <span><b>Current Bank</b><span className="note">{currentCount !== null ? `Existing questions saved in this browser (${currentCount} questions)` : "Existing questions saved in this browser"}</span></span>
      </label>
      <label className={`bankhost__choice${source === "independent" ? " bankhost__choice--on" : ""}`}>
        <input type="radio" name="bank-source" checked={source === "independent"} onChange={() => onChange("independent")} />
        <span><b>Independent VQS Word Bank</b><span className="note">{independentCount !== null && source === "independent" ? `Approved words stored on the server (${independentCount} approved)` : "Approved words stored on the server"}</span></span>
      </label>
      {/* Always shown (either bank selected, any number of words): the one way into Word Bank management from this page. Same tab. */}
      <a className="btn btn--small bankhost__manage" href="/wordbank">Manage Word Bank</a>
    </fieldset>
  );
}
