# Vocabulary Quiz Show (prototype v0.2 — Phase 2: Teacher Studio)

Two-player, face-to-face English vocabulary quiz. One student is the **Giver** (sees the word, explains it aloud); the other is the **Taker** (asks questions, types/dictates a guess).

**Status: front-end demo.** Everything runs on one screen in "demo mode". Phones are NOT paired or synchronised. No backend, accounts, API keys or AI calls.

## Run
```
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
npm run typecheck
npm test
```

## Done vs. placeholder
| Done | Placeholder |
|---|---|
| Welcome/names, 10-word sample set, word picker, Giver & Taker screens, hints + manual hint counter, answer checking, scoring, skip, role alternation, celebration/gentle-miss feedback, synthesised sounds, final winner/tie, demo-mode view switcher | Paired-phone sync (`createPairedTransport` in `src/lib/transport.ts` throws), set/category/CEFR picker UI, persistence, teacher tools |

## Scoring (provisional — `src/lib/scoring.ts`)
Taker = `max(25, 100 − 15 × hints)`; Giver = 50% of that; skip = 0; wrong guesses are free.
Hints = revealed prepared hints + spoken hints added with **+**.

## Layout
- `src/data/vocab.ts` — editable vocabulary (`VocabSet`, per-word `category`, `cefr`; opaque ids)
- `src/lib/game.ts` — pure reducer, `redactForTaker` (Taker screen never receives the answer)
- `src/lib/transport.ts` — seam for future paired-device sync
- `src/lib/{answer,scoring,sound,speech}.ts`, `src/components/*`, `src/app/globals.css`


## Phase 2 — Teacher Studio
Open the app → **Teacher Studio** (welcome screen). Talk to the AI producer, generate ten-word sets, review/edit, approve, save, and **Play this set**.

- **Real vs mock AI.** `POST /api/studio` runs on the server. With `OPENAI_API_KEY` set (server env only, e.g. `.env.local`; see `.env.example`; optional `OPENAI_MODEL`, default `gpt-4o-mini`) it calls OpenAI. With no key it uses a clearly labelled **mock AI** (demo bank in `src/lib/studio/ai/mockBank.ts`: common/less-common fruits, physical actions, personality & emotions, everyday expressions). The key never reaches the browser. When a key exists, "Use free mock" lets you test without cost.
- **Validation.** All AI output is checked (`src/lib/studio/validation.ts`): shape, CEFR/POS, exactly three hints, hints/category must not reveal the word, no duplicates. Bad items are dropped with reasons; one top-up call is made at most.
- **Editing is per-item.** `src/lib/studio/ops.ts` — replacing a word / regenerating hints touches only that word; whole-set regeneration keeps 🔒 locked words.
- **Storage.** Browser localStorage only (`vqs.activities.v1`): no sync between devices, not permanent. Nothing external.
- **Game link.** Approved sets appear in the welcome screen's "Word set" menu. The built-in sample stays available.


## Phase 3 — Two-phone classroom mode
**Teacher:** welcome screen → pick the word set → **Host for a class (two phones)** → share the link (it uses the laptop's Wi-Fi address). **Students:** open the link on their phones, enter name + group number (same number = same pair, max two players).

Run for a class (single process, same Wi-Fi):
```
npm run build && npm run start:lan -- -p 3200     # then open http://<laptop-ip>:3200
```
- Authoritative state lives **in the server's memory** (`src/lib/class/store.ts`), reached by short polling (`/api/class/...`). Restarting the server ends all games and invalidates links.
- Rooms are keyed by `activityId + group`; seats are claimed with a random per-phone token (kept in that phone's localStorage, sent in an `Authorization` header). The token — never the URL — decides seat and role.
- The Taker's responses never contain the word, definition, example, accepted answers or hints; the Giver only gets the word currently in play (`src/lib/class/views.ts`).
- **Not suitable for Vercel serverless** (instances don't share memory). A public HTTPS link needs a long-running Node host, or an external shared store.
- Demo mode (`/`) is unchanged.


## Voice: listening and speaking
- **Hearing words and hints (Giver):** the browser's built-in speech synthesis (free, offline). `src/lib/speech.ts` ranks the device's voices (natural/enhanced and well-known clear English voices first, novelty voices never), reads "____" as "blank", and allows only ONE playback at a time — starting another stops the first, pressing the playing button again stops it. Hints can be played once revealed (unrevealed hints cost points, so they stay hidden).
- **Speaking an answer (Taker):** a microphone button next to the answer box uses the browser's speech recognition (`src/lib/dictation.ts`). It starts only when pressed (that is when the permission prompt appears), listens to one short utterance, puts the words in the box for the student to edit, and NEVER submits. No audio is recorded or stored by the app; the browser's speech service (Google for Chrome, Apple for Safari) may process the audio.
- **Needs HTTPS on phones.** Microphone features require a secure context. `http://localhost` counts as secure; `http://192.168.x.x` (the classroom LAN link) does NOT — there the button explains this and typing / the keyboard's own microphone key still work.
