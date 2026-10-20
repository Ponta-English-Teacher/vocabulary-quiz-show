"use client";

import { useState } from "react";

export function TeacherPasscodeForm({ error, busy, onSubmit }: { error: string | null; busy: boolean; onSubmit: (passcode: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="welcome__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      <label className="field">
        <span className="field__label">Teacher passcode</span>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="current-password" maxLength={200} />
      </label>
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn--hero" disabled={busy || !value.trim()}>{busy ? "Checking…" : "Unlock teacher tools"}</button>
    </form>
  );
}
