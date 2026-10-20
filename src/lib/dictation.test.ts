import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkDictationSupport, createDictation, dictationErrorMessage, getRecognitionCtor, RECOGNITION_LANG, type RecognitionEventLike, type RecognitionLike } from "./dictation";

class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  static startThrows = false;
  lang = ""; continuous = true; interimResults = false; maxAlternatives = 0;
  onstart: (() => void) | null = null; onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null; onend: (() => void) | null = null;
  started = 0; stopped = 0; aborted = 0;
  constructor() { FakeRecognition.instances.push(this); }
  start() { if (FakeRecognition.startThrows) throw new Error("InvalidStateError"); this.started++; this.onstart?.(); }
  stop() { this.stopped++; this.onend?.(); }
  abort() { this.aborted++; }
  say(parts: { t: string; final: boolean }[]) {
    this.onresult?.({ resultIndex: 0, results: parts.map((p) => Object.assign([{ transcript: p.t }], { isFinal: p.final })) as never });
  }
}
const setup = () => {
  FakeRecognition.instances = [];
  FakeRecognition.startThrows = false;
  const text: [string, boolean][] = [];
  const states: boolean[] = [];
  const errors: string[] = [];
  const d = createDictation(FakeRecognition, { onText: (t, f) => text.push([t, f]), onListening: (l) => states.push(l), onError: (m) => errors.push(m) });
  return { d, text, states, errors, rec: () => FakeRecognition.instances[FakeRecognition.instances.length - 1] };
};

describe("support detection and messages", () => {
  it("finds the standard or webkit-prefixed constructor", () => {
    expect(getRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(getRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(getRecognitionCtor({})).toBeNull();
  });
  it("explains clearly when voice input is unavailable, and keeps typing as the alternative", () => {
    expect(checkDictationSupport({ webkitSpeechRecognition: FakeRecognition })).toEqual({ ok: true });
    const none = checkDictationSupport({ isSecureContext: true });
    expect(none).toMatchObject({ ok: false });
    expect(!none.ok && none.message).toMatch(/isn't supported in this browser.*Type your answer/);
    const insecure = checkDictationSupport({ isSecureContext: false });
    expect(!insecure.ok && insecure.message).toMatch(/HTTPS/);
    expect(!insecure.ok && insecure.message).toMatch(/microphone key on your keyboard/);
  });
  it("turns error codes into student-friendly advice; stopping by hand is silent", () => {
    expect(dictationErrorMessage("aborted")).toBeNull();
    expect(dictationErrorMessage("not-allowed", true)).toMatch(/blocked.*Allow microphone access/);
    expect(dictationErrorMessage("not-allowed", false)).toMatch(/HTTPS/);
    expect(dictationErrorMessage("service-not-allowed", false)).toMatch(/HTTPS/);
    expect(dictationErrorMessage("no-speech")).toMatch(/didn't hear anything/);
    expect(dictationErrorMessage("audio-capture")).toMatch(/No microphone/);
    expect(dictationErrorMessage("network")).toMatch(/internet/);
    expect(dictationErrorMessage("anything-else")).toMatch(/Type your answer/);
    for (const code of ["not-allowed", "no-speech", "audio-capture", "network", "language-not-supported", "x"]) {
      expect(dictationErrorMessage(code)).toMatch(/type/i); // every message offers typing
    }
  });
});

describe("listening only when asked", () => {
  it("creating the controller touches nothing: no microphone, no recognition object", () => {
    const { rec, states } = setup();
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(rec()).toBeUndefined();
    expect(states).toEqual([]);
  });
  it("starts exactly when the student presses: one short utterance, interim results, English", () => {
    const { d, rec } = setup();
    d.start();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(rec().started).toBe(1); // ← where the browser asks for microphone permission
    expect(rec()).toMatchObject({ lang: "en-US", continuous: false, interimResults: true, maxAlternatives: 1 });
    expect(d.isListening()).toBe(true);
  });
  it("pressing again while listening does not start a second recognition", () => {
    const { d } = setup();
    d.start();
    d.start();
    expect(FakeRecognition.instances).toHaveLength(1);
  });
  it("does not restart by itself when speech ends (no continuous recording)", () => {
    const { d, rec, states } = setup();
    d.start();
    rec().say([{ t: "umbrella", final: true }]);
    rec().onend?.();
    expect(d.isListening()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0].started).toBe(1);
    expect(states[states.length - 1]).toBe(false);
  });
});

describe("recognised words only fill the box — nothing is submitted", () => {
  it("passes interim then final text to the caller", () => {
    const { d, rec, text } = setup();
    d.start();
    rec().say([{ t: "um", final: false }]);
    rec().say([{ t: "umbrella", final: true }]);
    expect(text).toEqual([["um", false], ["umbrella", true]]);
  });
  it("joins multiple parts and tidies spaces", () => {
    const { d, rec, text } = setup();
    d.start();
    rec().say([{ t: " it is ", final: true }, { t: "an  umbrella", final: false }]);
    expect(text[0]).toEqual(["it is an umbrella", false]);
  });
  it("the controller has no way to submit: its only outputs are text, listening state and error messages", () => {
    const handlerKeys = ["onText", "onListening", "onError"];
    const src = readFileSync(new URL("./dictation.ts", import.meta.url), "utf8");
    for (const k of handlerKeys) expect(src).toContain(k);
    expect(src).not.toMatch(/GUESS|dispatch|submit\(|requestSubmit/);
  });
  it("the Taker screen puts dictated text in the input and submits only through the form's own submit", () => {
    const src = readFileSync(new URL("../components/TakerRound.tsx", import.meta.url), "utf8");
    expect(src).toContain("useDictation((heard) => setText(heard), RECOGNITION_LANG.en)");
    expect(src).toContain("useDictation((heard) => setJaText(heard), RECOGNITION_LANG.ja)");
    expect(src.match(/type: "GUESS"/g)).toHaveLength(1); // the single English submit path
    expect(src.match(/type: "GUESS_JA"/g)).toHaveLength(1); // the single Japanese submit path
    expect(src).toMatch(/onSubmit=\{\(e\) => \{[^}]*micEn\.abort\(\);[^}]*dispatch\(\{ type: "GUESS"/s);
    expect(src).toMatch(/onSubmit=\{\(e\) => \{[^}]*micJa\.abort\(\);[^}]*dispatch\(\{ type: "GUESS_JA"/s);
    expect(src.match(/type="submit"/g)).toHaveLength(2); // one submit button per box, nothing else submits
    expect(src).toMatch(/aria-label=\{micEn\.listening \? "Stop listening" : "Speak your answer in English"\}/);
    expect(src).toMatch(/aria-label=\{micJa\.listening \? "Stop listening" : "Speak your answer in Japanese"\}/);
    expect(src).toMatch(/Typing always works/); // typing stays a fully functional alternative
  });
});

describe("errors, stopping and privacy", () => {
  it("reports permission denial with advice and stops listening", () => {
    const { d, rec, errors, states } = setup();
    d.start();
    rec().onerror?.({ error: "not-allowed" });
    expect(errors[0]).toMatch(/blocked/);
    expect(d.isListening()).toBe(false);
    expect(states[states.length - 1]).toBe(false);
  });
  it("is quiet when the student stops it themselves", () => {
    const { d, rec, errors } = setup();
    d.start();
    rec().onerror?.({ error: "aborted" });
    expect(errors).toEqual([]);
  });
  it("handles start() throwing (e.g. already started) without crashing", () => {
    const { d, errors, states } = setup();
    FakeRecognition.startThrows = true;
    d.start();
    expect(errors[0]).toMatch(/couldn't start.*Type your answer/);
    expect(d.isListening()).toBe(false);
    expect(states[states.length - 1]).toBe(false);
  });
  it("stop() finishes and keeps what was heard; abort() silences everything immediately", () => {
    const { d, rec, text } = setup();
    d.start();
    rec().say([{ t: "bor", final: false }]);
    d.stop();
    expect(rec().stopped).toBe(1);
    expect(d.isListening()).toBe(false);
    d.start();
    const r2 = rec();
    d.abort();
    expect(r2.aborted).toBe(1);
    r2.say([{ t: "late result", final: true }]); // callbacks were detached
    expect(text.map((t) => t[0])).toEqual(["bor"]);
    expect(d.isListening()).toBe(false);
  });
  it("never records or stores audio: no MediaRecorder, getUserMedia, storage or network code in the voice-input modules", () => {
    for (const f of ["./dictation.ts", "../components/useDictation.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/MediaRecorder|getUserMedia|AudioContext|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|Blob\(/);
    }
  });
  it("stops speaking before listening so the phone doesn't hear itself", () => {
    const src = readFileSync(new URL("../components/useDictation.ts", import.meta.url), "utf8");
    expect(src).toMatch(/stopSpeaking\(\);[\s\S]*dictation\.current\.start\(\)/);
  });
});

it("the hook is only invoked from a button press — the TakerRound never calls toggle on mount", () => {
  const src = readFileSync(new URL("../components/TakerRound.tsx", import.meta.url), "utf8");
  expect(src.match(/micEn\.toggle\(\)/g)).toHaveLength(1);
  expect(src.match(/micJa\.toggle\(\)/g)).toHaveLength(1);
  expect(src).not.toMatch(/useEffect\([^)]*mic(En|Ja)\.toggle/s);
  expect(src).not.toMatch(/\.start\(\)/); // nothing starts listening except the press handler in the hook
  vi.fn();
});

describe("microphone language follows the answer box", () => {
  const setupLang = (lang?: (typeof RECOGNITION_LANG)[keyof typeof RECOGNITION_LANG]) => {
    FakeRecognition.instances = [];
    const text: [string, boolean][] = [];
    const errors: string[] = [];
    const d = createDictation(FakeRecognition, { onText: (t, f) => text.push([t, f]), onListening: () => {}, onError: (m) => errors.push(m) }, lang ? { lang } : {});
    return { d, text, errors, rec: () => FakeRecognition.instances[FakeRecognition.instances.length - 1] };
  };
  it("defines exactly two recognition languages: en-US and ja-JP", () => {
    expect(RECOGNITION_LANG).toEqual({ en: "en-US", ja: "ja-JP" });
  });
  it("the normal English answer box listens for en-US (also when no language is given)", () => {
    for (const lang of [undefined, RECOGNITION_LANG.en] as const) {
      const { d, rec } = setupLang(lang);
      d.start();
      expect(rec().lang).toBe("en-US");
    }
  });
  it("the Japanese answer box listens for ja-JP", () => {
    const { d, rec } = setupLang(RECOGNITION_LANG.ja);
    d.start();
    expect(rec().lang).toBe("ja-JP");
    expect(rec()).toMatchObject({ continuous: false, interimResults: true }); // still one short, press-to-talk utterance
  });
  it("neither box listens until its microphone button is pressed", () => {
    const en = setupLang(RECOGNITION_LANG.en), ja = setupLang(RECOGNITION_LANG.ja);
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(en.d.isListening() || ja.d.isListening()).toBe(false);
  });
  it("Japanese speech only fills the box (text out, nothing submitted) and can be corrected before sending", () => {
    const { d, text, rec } = setupLang(RECOGNITION_LANG.ja);
    d.start();
    rec().say([{ t: "ざる", final: true }]);
    expect(text).toEqual([["ざる", true]]);
  });
  it("tells the student, in terms of the language, when the browser can't recognise it", () => {
    expect(dictationErrorMessage("language-not-supported", true, RECOGNITION_LANG.ja)).toMatch(/Japanese/);
    expect(dictationErrorMessage("language-not-supported", true, RECOGNITION_LANG.en)).toMatch(/English/);
    const { d, errors, rec } = setupLang(RECOGNITION_LANG.ja);
    d.start();
    rec().onerror?.({ error: "language-not-supported" });
    expect(errors[0]).toMatch(/Japanese.*Type your answer/);
  });
  it("there is no language toggle in the normal answer box; Japanese is reached only through the situation button", () => {
    const src = readFileSync(new URL("../components/TakerRound.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/<select|role="switch"|English \/ Japanese|JP \/ EN/);
    expect(src.match(/I know it, but not in English!/g)).toHaveLength(1);
    expect(src.match(/setMode\("ja"\)/g)).toHaveLength(1); // the only way into the Japanese box
  });
  it("the hook passes the box's language to the recognition object and nothing else decides it", () => {
    const src = readFileSync(new URL("../components/useDictation.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\{ secure: window\.isSecureContext !== false, lang \}/);
    expect(src).not.toMatch(/navigator\.language/);
  });
});
