import type { BankIssue } from "@/lib/bank/types";

/** Validation problems and teacher-review notes, kept visibly apart: errors block approval, warnings never do. */
export function IssueLists({ errors, warnings }: { errors: readonly BankIssue[]; warnings: readonly BankIssue[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <div className="wb__issues">
      {errors.length ? (
        <div className="wb__errors" role="alert">
          <p className="wb__issues-title">Must fix before approval</p>
          <ul>{errors.map((i, k) => <li key={`${i.code}-${i.hintIndex ?? ""}-${k}`}>{i.message}</li>)}</ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="wb__warnings">
          <p className="wb__issues-title">For your review — does not block approval</p>
          <ul>{warnings.map((i, k) => <li key={`${i.code}-${i.hintIndex ?? ""}-${k}`}>{i.message}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
