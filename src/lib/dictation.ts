/**
 * Voice input for the Taker's answer box, using the browser's own speech recognition
 * (Web Speech API: `SpeechRecognition` / `webkitSpeechRecognition`).
 *
 * Rules this module enforces:
 *  - Nothing starts until the student presses the microphone button — the permission prompt appears then.
 *  - One short utterance per press (not continuous), then it stops by itself.
 *  - It only ever hands TEXT to the caller; it never submits an answer, and it never records or stores audio.
 *    (The browser's speech service — Google for Chrome, Apple for Safari — may process the audio to transcribe it.)
 */

export interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
export interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => RecognitionLike;

export interface DictationEnv {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  isSecureContext?: boolean;
}

export function getRecognitionCtor(env: DictationEnv): RecognitionCtor | null {
  return env.SpeechRecognition ?? env.webkitSpeechRecognition ?? null;
}

export type DictationSupport = { ok: true } | { ok: false; message: string };

export function checkDictationSupport(env: DictationEnv): DictationSupport {
  if (getRecognitionCtor(env)) return { ok: true };
  return {
    ok: false,
    message:
      env.isSecureContext === false
        ? "Voice input isn't available here — it usually needs a secure (HTTPS) connection. Type your answer, or use the microphone key on your keyboard."
        : "Voice input isn't supported in this browser. Type your answer, or use the microphone key on your keyboard.",
  };
}

/** A student-friendly message for a recognition error code (null = ignore, e.g. the student stopped it). */
export function dictationErrorMessage(code: string, secure = true): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return secure
        ? "The microphone is blocked. Allow microphone access for this site in your browser settings, or type your answer."
        : "The microphone can't be used because this page isn't on a secure (HTTPS) connection. Type your answer, or use the microphone key on your keyboard.";
    case "no-speech":
      return "I didn't hear anything. Press the microphone and try again, or type your answer.";
    case "audio-capture":
      return "No microphone was found. Type your answer instead.";
    case "network":
      return "Voice input needs an internet connection. Type your answer instead.";
    case "language-not-supported":
      return "This browser can't recognise English speech. Type your answer instead.";
    default:
      return "Voice input didn't work. Type your answer instead.";
  }
}

export interface DictationHandlers {
  /** Recognised words so far. `final` is true once the browser is sure. The caller puts this in the input box — nothing more. */
  onText(text: string, final: boolean): void;
  onListening(listening: boolean): void;
  onError(message: string): void;
}

export interface Dictation {
  start(): void;
  /** Finish and keep what was heard. */
  stop(): void;
  /** Drop everything immediately (used on unmount / when the answer is submitted). */
  abort(): void;
  isListening(): boolean;
}

export function createDictation(Ctor: RecognitionCtor, handlers: DictationHandlers, opts: { lang?: string; secure?: boolean } = {}): Dictation {
  let rec: RecognitionLike | null = null;
  let listening = false;

  const finish = () => {
    if (!listening) return;
    listening = false;
    rec = null;
    handlers.onListening(false);
  };

  return {
    isListening: () => listening,
    start() {
      if (listening) return;
      try {
        const r = new Ctor(); // a fresh instance per press is the most reliable on iOS
        rec = r;
        r.lang = opts.lang ?? "en-US";
        r.continuous = false; // one short answer, then it stops by itself
        r.interimResults = true;
        r.maxAlternatives = 1;
        r.onstart = () => {
          listening = true;
          handlers.onListening(true);
        };
        r.onresult = (e) => {
          let text = "";
          let final = true;
          for (let i = 0; i < e.results.length; i++) {
            text += e.results[i][0].transcript;
            if (!e.results[i].isFinal) final = false;
          }
          handlers.onText(text.replace(/\s+/g, " ").trim(), final);
        };
        r.onerror = (e) => {
          const msg = dictationErrorMessage(e.error, opts.secure ?? true);
          if (msg) handlers.onError(msg);
          finish();
        };
        r.onend = finish;
        listening = true; // optimistic: the button shows "listening" while the permission prompt is open
        handlers.onListening(true);
        r.start(); // ← the browser asks for microphone permission here, because the student pressed the button
      } catch {
        listening = false;
        rec = null;
        handlers.onListening(false);
        handlers.onError("Voice input couldn't start. Type your answer instead.");
      }
    },
    stop() {
      try {
        rec?.stop();
      } catch {
        finish();
      }
    },
    abort() {
      const r = rec;
      if (r) {
        r.onresult = r.onerror = r.onend = r.onstart = null;
        try {
          r.abort();
        } catch {
          /* already stopped */
        }
      }
      finish();
    },
  };
}
