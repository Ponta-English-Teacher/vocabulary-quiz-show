"use client";

import { useEffect, useRef, useState } from "react";
import type { Brief, ChatMessage } from "@/lib/studio/types";
import { CandidateEditor } from "./CandidateEditor";

const IDEAS = [
  "Create A1 vocabulary about common fruits.",
  "Make a B2 activity about everyday physical actions.",
  "I want C1 vocabulary for describing personality and emotions.",
  "Focus on expressions Japanese students may understand but struggle to produce.",
];

export function ChatPanel({
  messages,
  brief,
  onCandidates,
  busy,
  canGenerate,
  setsLabel,
  onSend,
  onGenerate,
}: {
  messages: ChatMessage[];
  brief: Brief;
  onCandidates: (b: Brief) => void;
  busy: string | null;
  canGenerate: boolean;
  setsLabel: string;
  onSend: (text: string) => void;
  onGenerate: () => void;
}) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages.length, busy]);

  const send = (t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    setText("");
    onSend(v);
  };

  const summary = [brief.level, brief.topic, brief.learnerFocus ? "tailored to your learners" : ""].filter(Boolean);

  return (
    <section className="pane pane--chat" aria-labelledby="chat-h">
      <h2 id="chat-h" className="pane__title">
        <span className="pane__kicker">Writers&apos; room</span>
        Talk it through
      </h2>

      {summary.length > 0 ? (
        <p className="brief" aria-label="Current plan">
          <span className="brief__label">Plan</span> {summary.join(" · ")} · {brief.numSets} set{brief.numSets === 1 ? "" : "s"}
          {brief.balance ? <> · {brief.balance}</> : null}
          {brief.approvalPending ? <> · <b className="c-gold">waiting for your approval</b></> : null}
        </p>
      ) : null}

      {brief.candidates.length > 0 ? <CandidateEditor brief={brief} busy={!!busy} onChange={onCandidates} /> : null}

      <div className="chat" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="chat__intro">
            <p>Tell me what you&apos;d like your students to practise. A sentence is enough — I&apos;ll ask if I need more.</p>
            <ul className="ideas">
              {IDEAS.map((i) => (
                <li key={i}>
                  <button type="button" className="idea" onClick={() => send(i)} disabled={!!busy}>{i}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`msg msg--${m.role}`}>
              <span className="msg__who">{m.role === "ai" ? "AI producer" : "You"}</span>
              <p>{m.text}</p>
            </div>
          ))
        )}
        {busy ? (
          <div className="msg msg--ai msg--busy" aria-live="polite">
            <span className="msg__who">AI producer</span>
            <p>
              {busy}
              <span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
            </p>
          </div>
        ) : null}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="studio-msg" className="sr-only">Message to the AI producer</label>
        <textarea
          id="studio-msg"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder={messages.length ? "Ask for changes, e.g. “less common words” or “replace #3”…" : "Describe your activity…"}
          disabled={!!busy}
          maxLength={1500}
        />
        <div className="composer__row">
          <button type="button" className="btn btn--small" onClick={onGenerate} disabled={!canGenerate || !!busy}
            title={canGenerate ? undefined : "Tell me a topic first"}>
            {brief.candidates.length > 0 ? `Generate from my ${brief.candidates.length} word${brief.candidates.length === 1 ? "" : "s"}` : `Generate ${setsLabel}`}
          </button>
          <button type="submit" className="btn btn--small btn--send" disabled={!text.trim() || !!busy}>Send</button>
        </div>
      </form>
    </section>
  );
}
