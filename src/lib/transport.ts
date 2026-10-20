import { createInitialState, gameReducer, type GameAction, type GameState } from "./game";

/**
 * Transport layer — the seam for future paired-device play.
 *
 * UI code only ever talks to a GameTransport: read `getState()`, send actions
 * with `dispatch()`, listen with `subscribe()`.
 *
 *  ✅ createLocalTransport — IMPLEMENTED. One in-memory game on one screen
 *     (the demo mode). Nothing leaves the browser.
 *  🚧 createPairedTransport — PLACEHOLDER. Will connect two phones to the same
 *     game room and apply the same reducer; deliberately throws for now.
 *     Nothing here is synchronised between devices yet.
 */
export interface GameTransport {
  readonly kind: "local-demo" | "paired";
  getState(): GameState;
  dispatch(action: GameAction): void;
  subscribe(listener: () => void): () => void;
}

export function createLocalTransport(initial: GameState = createInitialState()): GameTransport {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    kind: "local-demo",
    getState: () => state,
    dispatch(action) {
      const next = gameReducer(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** PLACEHOLDER — not implemented. See the note at the top of this file. */
export function createPairedTransport(): GameTransport {
  throw new Error("Paired-device play is not implemented yet (demo mode only).");
}
