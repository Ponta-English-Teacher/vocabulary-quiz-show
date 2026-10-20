"use client";

import { useRef, useState } from "react";
import type { VocabSet, VocabWord } from "@/data/vocab";
import { callStudio, StudioClientError } from "@/lib/studio/ai/client";
import type { StudioData, StudioRequest } from "@/lib/studio/ai/types";
import {
  addSet, allTargetForms, appendWords, approveSet, regenerateSet, removeSet, renameActivity,
  replaceWord, setBrief, setHints, splitApproved, toggleLock, toVocabSet, updateWord,
} from "@/lib/studio/ops";
import { getBrowserStorage, saveActivity } from "@/lib/studio/storage";
import { SET_SIZE, type Activity, type Brief, type StudioCommand } from "@/lib/studio/types";
import { ChatPanel } from "./ChatPanel";
import { SetPanel } from "./SetPanel";
import { Notice, StorageNotice, type AiStatus } from "./shared";

type ReqOf<T extends StudioData["task"]> = Extract<StudioRequest, { task: T }>;

export function Workshop({
  initial,
  ai,
  onBack,
  onSaved,
  onPlay,
}: {
  initial: Activity;
  ai: AiStatus;
  onBack: () => void;
  onSaved: () => void;
  onPlay: (set: VocabSet) => void;
}) {
  const [activity, setActivity] = useState(initial);
  // Always-current copy: async AI replies are applied to THIS, so they never clobber edits made meanwhile.
  const actRef = useRef(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyWordId, setBusyWordId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [activeSetId, setActiveSetId] = useState<string | null>(initial.sets[0]?.id ?? null);
  const [tab, setTab] = useState<"chat" | "sets">(initial.sets.length ? "sets" : "chat");
  const [approveProblems, setApproveProblems] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  const commit = (next: Activity) => {
    actRef.current = next;
    setActivity(next);
    setDirty(true);
    setSavedAt(false);
    setApproveProblems([]);
  };

  const call = <T extends StudioData["task"]>(task: T, params: Omit<ReqOf<T>, "task" | "forceMock">) =>
    callStudio(task, { ...params, forceMock: ai.forceMock });

  const aiSay = (text: string) => commit({ ...actRef.current, messages: [...actRef.current.messages, { role: "ai", text }] });
  const fail = (e: unknown) =>
    setNotice({ kind: "error", text: e instanceof StudioClientError ? e.message : "Something went wrong. Nothing was changed." });

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      setBusyWordId(null);
    }
  };

  const findWord = (setId: string, wordId: string): VocabWord | undefined =>
    actRef.current.sets.find((s) => s.id === setId)?.words.find((w) => w.id === wordId);

  // ---- AI operations (each touches only what it names) -----------------------------

  const doGenerate = async (brief: Brief, n: number, instruction?: string) => {
    let made = 0;
    // Words the teacher approved are used exactly, ten per set; anything left over goes to the next set.
    const chunks = splitApproved(brief.approvedWords);
    const total = Math.max(n, chunks.length);
    for (let i = 0; i < total; i++) {
      setBusy(total > 1 ? `Writing set ${i + 1} of ${total}` : "Writing your set");
      const exclude = allTargetForms(actRef.current);
      const approved = chunks[i] ?? [];
      const { data } = await call("generate", { brief, count: SET_SIZE, exclude, approved, instruction });
      if (data.words.length === 0) {
        setNotice({ kind: "error", text: data.issues[0] ?? "No usable words came back. Nothing was changed." });
        break;
      }
      const next = addSet(actRef.current, data.words);
      commit(next);
      setActiveSetId(next.sets[next.sets.length - 1].id);
      made++;
      if (data.words.length < SET_SIZE) {
        setNotice({
          kind: "error",
          text: `I could only produce ${data.words.length} valid words for Set ${next.sets.length} (${SET_SIZE} needed). ${data.issues.length} item${data.issues.length === 1 ? " was" : "s were"} rejected. ${data.issues.slice(0, 2).join(" ")} Use “Ask AI for ${SET_SIZE - data.words.length} more”, or add words by hand.`,
        });
      }
    }
    if (brief.approvedWords.length || brief.candidates.length) {
      // The approved list has been used; don't let it leak into later "add set" requests.
      commit(setBrief(actRef.current, { ...actRef.current.brief, approvedWords: [], candidates: [], candidateBands: { familiar: [], moderate: [], unfamiliar: [] }, approvalPending: false }));
    }
    if (made > 0) {
      setTab("sets");
      aiSay(`Here ${made === 1 ? "is your set" : `are your ${made} sets`}. Skim every word, open any item to edit it, and approve when you're happy. Tell me what to change — for example “replace #4 with something less common”.`);
    }
  };

  const doReplace = async (setId: string, wordId: string, instruction?: string) => {
    const word = findWord(setId, wordId);
    if (!word) return setNotice({ kind: "error", text: "That word no longer exists." });
    setBusy("Finding a replacement");
    setBusyWordId(wordId);
    const { data } = await call("replace-word", { brief: actRef.current.brief, current: word, exclude: allTargetForms(actRef.current), instruction: instruction || undefined,
    });
    const r = replaceWord(actRef.current, setId, wordId, data.word);
    if (r.error) return setNotice({ kind: "error", text: r.error });
    commit(r.activity);
    setNotice({ kind: "info", text: `Replaced “${word.word}” with “${data.word.word}”. The other words weren't touched.` });
  };

  const doHints = async (setId: string, wordId: string, instruction?: string) => {
    const word = findWord(setId, wordId);
    if (!word) return setNotice({ kind: "error", text: "That word no longer exists." });
    setBusy("Writing new hints");
    setBusyWordId(wordId);
    const { data } = await call("regenerate-hints", { brief: actRef.current.brief, word, instruction: instruction || undefined });
    commit(setHints(actRef.current, setId, wordId, data.hints));
    setNotice({ kind: "info", text: `New hints for “${word.word}”. Only its hints changed.` });
  };

  const doRegenSet = async (setId: string, instruction?: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    const open = set.words.filter((w) => !set.lockedIds.includes(w.id)).length;
    if (open === 0) return setNotice({ kind: "info", text: "Every word in this set is locked, so there's nothing to regenerate." });
    setBusy("Regenerating the set");
    const { data } = await call("generate", { brief: actRef.current.brief, count: open, exclude: allTargetForms(actRef.current), instruction,
    });
    const r = regenerateSet(actRef.current, setId, data.words);
    commit(r.activity);
    setNotice({ kind: "info", text: `${r.replaced} word${r.replaced === 1 ? "" : "s"} replaced${set.lockedIds.length ? `; ${set.lockedIds.length} locked kept` : ""}.` });
  };

  const doFill = async (setId: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    setBusy("Finding more words");
    const { data } = await call("generate", { brief: actRef.current.brief, count: SET_SIZE - set.words.length, exclude: allTargetForms(actRef.current),
    });
    const next = appendWords(actRef.current, setId, data.words);
    commit(next);
    const have = next.sets.find((x) => x.id === setId)?.words.length ?? 0;
    if (have < SET_SIZE) {
      setNotice({ kind: "error", text: `Still ${SET_SIZE - have} short (${have}/${SET_SIZE}). ${data.issues.slice(0, 2).join(" ")} You can try again or add words by hand.` });
    }
  };

  const runCommand = async (cmd: StudioCommand, brief: Brief) => {
    const set = actRef.current.sets.find((s) => s.id === activeSetId) ?? actRef.current.sets[0];
    if (cmd.type === "generate") return doGenerate(brief, brief.numSets);
    if (!set) return setNotice({ kind: "info", text: "Generate a set first, then I can change it." });
    if (cmd.type === "regenerate-set") return doRegenSet(set.id, cmd.instruction);
    const word = set.words[cmd.position - 1];
    if (!word) return setNotice({ kind: "error", text: `There is no word #${cmd.position} in this set.` });
    return cmd.type === "replace-word" ? doReplace(set.id, word.id, cmd.instruction) : doHints(set.id, word.id, cmd.instruction);
  };

  const sendChat = (text: string) =>
    run("Thinking", async () => {
      const messages = [...actRef.current.messages, { role: "teacher" as const, text }];
      commit({ ...actRef.current, messages });
      const set = actRef.current.sets.find((s) => s.id === activeSetId) ?? actRef.current.sets[0];
      const context = set ? { words: set.words.map((w, i) => ({ position: i + 1, word: w.word, cefr: w.cefr })) } : undefined;
      const { data } = await call("chat", { messages, brief: actRef.current.brief, context });
      const r = data.result;
      commit(setBrief({ ...actRef.current, messages: [...actRef.current.messages, { role: "ai", text: r.reply }] }, r.brief));
      if (r.command) await runCommand(r.command, r.brief);
    });

  // ---- manual edits & housekeeping -------------------------------------------------

  const save = (): boolean => {
    const res = saveActivity(getBrowserStorage(), actRef.current);
    if (!res.ok) {
      setNotice({ kind: "error", text: res.error });
      return false;
    }
    setDirty(false);
    setSavedAt(true);
    onSaved();
    return true;
  };

  const play = (setId: string) => {
    const set = actRef.current.sets.find((s) => s.id === setId);
    if (!set) return;
    save();
    onPlay(toVocabSet(actRef.current, set));
  };

  const brief = activity.brief;
  const canGenerate = brief.topic.trim().length > 0;
  const setsLabel = `${brief.numSets} set${brief.numSets === 1 ? "" : "s"}`;

  return (
    <section className="workshop" aria-label="Activity workshop">
      <div className="ws-bar">
        {leaving ? (
          <span className="confirm" role="group" aria-label="Unsaved changes">
            <span className="confirm__text">You have unsaved changes.</span>
            <button type="button" className="btn btn--small" onClick={() => { if (save()) onBack(); }}>Save &amp; leave</button>
            <button type="button" className="btn btn--small btn--danger" onClick={onBack}>Leave without saving</button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setLeaving(false)}>Stay</button>
          </span>
        ) : (
          <button type="button" className="btn btn--link" onClick={() => (dirty ? setLeaving(true) : onBack())}>‹ All activities</button>
        )}
        <label className="titlefld">
          <span className="sr-only">Activity title</span>
          <input value={activity.title} onChange={(e) => commit(renameActivity(actRef.current, e.target.value))} maxLength={80} />
        </label>
        <div className="ws-save">
          <span className="ws-status" aria-live="polite">{dirty ? "Unsaved changes" : savedAt ? "Saved ✓" : ""}</span>
          <button type="button" className="btn btn--small btn--save" onClick={save} disabled={!dirty && savedAt}>Save</button>
        </div>
      </div>

      {notice ? <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice> : null}

      <div className="tabswitch" role="tablist" aria-label="Workshop view">
        <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Writers&apos; room</button>
        <button type="button" role="tab" aria-selected={tab === "sets"} onClick={() => setTab("sets")}>
          The lineup{activity.sets.length ? ` (${activity.sets.length})` : ""}
        </button>
      </div>

      <div className="workshop__grid" data-tab={tab}>
        <ChatPanel
          messages={activity.messages}
          brief={brief}
          busy={busy}
          canGenerate={canGenerate}
          setsLabel={setsLabel}
          onSend={sendChat}
          onGenerate={() => run("Writing your set", async () => {
            // Pressing Generate is the teacher's approval: release any "discuss first" hold.
            const cur = actRef.current.brief;
            // Clicking Generate while candidates are on the table approves exactly those candidates.
            const brief = {
              ...cur,
              approvalPending: false,
              approvedWords: cur.approvalPending && cur.candidates.length ? cur.candidates : cur.approvedWords,
            };
            commit(setBrief(actRef.current, brief));
            await doGenerate(brief, brief.numSets);
          })}
        />
        <SetPanel
          sets={activity.sets}
          activeId={activeSetId}
          busy={busy}
          busyWordId={busyWordId}
          canGenerate={canGenerate}
          onSelect={(id) => { setActiveSetId(id); setApproveProblems([]); }}
          onAddSet={() => run("Writing another set", () => doGenerate(actRef.current.brief, 1))}
          onRemoveSet={(id) => {
            const next = removeSet(actRef.current, id);
            commit(next);
            setActiveSetId(next.sets[0]?.id ?? null);
          }}
          onEdit={(s, w, patch) => commit(updateWord(actRef.current, s, w, patch))}
          onToggleLock={(s, w) => commit(toggleLock(actRef.current, s, w))}
          onReplace={(s, w, ins) => run("Finding a replacement", () => doReplace(s, w, ins))}
          onNewHints={(s, w, ins) => run("Writing new hints", () => doHints(s, w, ins))}
          onRegenerateSet={(s) => run("Regenerating the set", () => doRegenSet(s))}
          onFill={(s) => run("Finding more words", () => doFill(s))}
          onApprove={(s) => {
            const r = approveSet(actRef.current, s);
            if (r.problems.length) return setApproveProblems(r.problems);
            commit(r.activity);
          }}
          onPlay={play}
          approveProblems={approveProblems}
        />
      </div>

      <StorageNotice />
    </section>
  );
}
