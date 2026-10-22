"use client";

import { useRef, useState } from "react";
import type { Illustration } from "@/data/vocab";
import { SCORING, takerPointsFor } from "@/lib/scoring";

export type RequestResult = { ok: true } | { ok: false; message: string };

/** The picture, once the Giver has asked for it. Private to the Giver's screen. */
export function GiverPicture({ used, illustration }: { used: boolean; illustration?: Illustration }) {
  if (!used) return null;
  if (!illustration?.src) {
    return <p className="note" role="status">You asked for an illustration, but it can&apos;t be shown right now. This word is still worth at most {SCORING.ILLUSTRATION_MAX} points.</p>;
  }
  return (
    <figure className="giver-pic">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={illustration.src} alt={illustration.alt ?? "Picture of the word (for you only)"} />
      <figcaption className="note">
        Illustration — only you can see this. It counts as a last-resort hint: this word is now worth at most {SCORING.ILLUSTRATION_MAX} points. Keep explaining in English!
      </figcaption>
    </figure>
  );
}

/**
 * "I need an illustration": a last-resort hint that costs points, so it asks for confirmation before any paid image call.
 * While the picture is being made the game keeps running (the request is just a pending promise); a failure costs nothing.
 */
export function IllustrationRequest({ onRequest }: { onRequest: () => Promise<RequestResult> }) {
  const [step, setStep] = useState<"idle" | "confirm" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // a double-tap can't start two requests

  const go = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStep("loading");
    setError(null);
    try {
      const r = await onRequest();
      if (!r.ok) setError(r.message);
    } catch {
      setError("Something went wrong. Your score is unchanged.");
    } finally {
      inFlight.current = false;
      setStep("idle");
    }
  };

  const max = SCORING.ILLUSTRATION_MAX;
  return (
    <section className="illreq" aria-label="Illustration, last resort">
      {step === "idle" ? (
        <>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => { setError(null); setStep("confirm"); }}>
            I need an illustration
          </button>
          <p className="note">Last resort. Try questions and hints first.</p>
        </>
      ) : null}
      {step === "confirm" ? (
        <div className="illreq__confirm" role="group" aria-label="Confirm illustration">
          <p><b>An illustration will reduce the available score to {max} points.</b></p>
          <p className="note">({takerPointsFor(0, "ja", true)} if answered in Japanese.) Only you will see the picture.</p>
          <div className="row">
            <button type="button" className="btn btn--small" onClick={go}>Show illustration</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setStep("idle")}>Cancel</button>
          </div>
        </div>
      ) : null}
      {step === "loading" ? (
        <p className="note" role="status" aria-live="polite">Drawing your illustration… this can take up to a minute. Keep talking — the game goes on.</p>
      ) : null}
      {error ? <p className="feedback feedback--wrong" role="alert">{error}</p> : null}
    </section>
  );
}
