"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getSpeakingId, speechAvailable, subscribeSpeech } from "./speech";

/** True while the utterance with this id is playing (so its button can show "Stop"). */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(subscribeSpeech, () => getSpeakingId() === id, () => false);
}

/** Whether speech synthesis exists — resolved after mount so server and client markup agree. */
export function useCanSpeak(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => setCan(speechAvailable()), []);
  return can;
}
