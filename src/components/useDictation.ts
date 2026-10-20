"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkDictationSupport, createDictation, getRecognitionCtor, RECOGNITION_LANG, type Dictation, type DictationEnv, type RecognitionLang } from "@/lib/dictation";
import { stopSpeaking } from "@/lib/speech";

/**
 * Press-to-talk dictation for one text field. `onText` receives the recognised words; it never submits anything.
 * `lang` is fixed for the lifetime of the field (English box → en-US, Japanese box → ja-JP).
 */
export function useDictation(onText: (text: string, final: boolean) => void, lang: RecognitionLang = RECOGNITION_LANG.en) {
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const env = (): DictationEnv => window as unknown as DictationEnv;

  const toggle = useCallback(() => {
    setMessage(null);
    if (dictation.current?.isListening()) return dictation.current.stop();
    const support = checkDictationSupport(env());
    if (!support.ok) return setMessage(support.message);
    if (!dictation.current) {
      dictation.current = createDictation(
        getRecognitionCtor(env())!,
        { onText: (t, f) => onTextRef.current(t, f), onListening: setListening, onError: setMessage },
        { secure: window.isSecureContext !== false, lang },
      );
    }
    stopSpeaking(); // don't let the phone's own voice be picked up as the answer
    dictation.current.start();
  }, [lang]);

  const abort = useCallback(() => dictation.current?.abort(), []);

  // Stop listening if the student leaves the page or the component goes away.
  useEffect(() => {
    const hide = () => document.hidden && dictation.current?.abort();
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      dictation.current?.abort();
    };
  }, []);

  return { listening, message, toggle, abort };
}
