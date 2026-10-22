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
| Welcome (clearly separated classroom and demo modes), 10-word sample set, word picker, Giver & Taker screens, free opening hint, extra hints + manual hint counter, English and Japanese answers, scoring, skip, role alternation, celebration/gentle-miss feedback, synthesised sounds, final winner/tie, demo-mode view switcher, two-phone classroom mode, Teacher Studio | Picture hints, a set/category/CEFR picker for students |

## Scoring (`src/lib/scoring.ts`)
- The **opening hint is free**: hint 1 appears automatically on the **Giver's screen only** at the start of every round (prepared data — no AI call). The Taker never receives it (the server strips it from their view, and demo mode's Taker screen uses the same redaction); the Taker is told to "Ask your partner questions to find out the word". Extra hints the Giver reveals still appear on both screens.
- English answer = `max(25, 100 − 15 × extraHints)`. A correct **Japanese** answer (the "I know it, but not in English!" button) earns **half** of that. The Giver gets half of what the Taker was awarded. A skip = 0; wrong answers are free; a correct answer ends the round.
- Extra hints = revealed hints 2 and 3 + spoken hints added with **+**. Questions and spoken answers are always free.
- **Rounding rule:** halves round **up** (`Math.round`; 42.5 → 43), applied to each amount separately, so every score is an integer and identical on both phones.

| extra hints | 0 | 1 | 2 | 3 | 4 | 5+ |
|---|---|---|---|---|---|---|
| Taker, English | 100 | 85 | 70 | 55 | 40 | 25 |
| Taker, Japanese | 50 | 43 | 35 | 28 | 20 | 13 |
| Giver, English | 50 | 43 | 35 | 28 | 20 | 13 |
| Giver, Japanese | 25 | 22 | 18 | 14 | 10 | 7 |

## Giver notes and Japanese answers
Words may carry two optional extras (older saved sets simply don't have them and still play):
- `giverInfo` — `looks`, `use`, `phrases`: private, easy English the Giver can use to answer questions (shown only on the Giver's screen).
- `ja` — approved Japanese equivalents (max 8). A Japanese answer scores **only if it matches one of these** (`src/lib/japanese.ts`: hiragana/katakana, full/half-width, spaces, punctuation and polite endings are ignored; kanji spellings and synonyms must be listed; no fuzzy matching). Matching happens on the server; the answers are never sent to the Taker or the Giver while the word is in play, only shown on the answer screen. No `ja` = no Japanese credit (the student is told).
- Teacher Studio generates both fields with the same AI call as the rest of the word (no per-round AI) and lets teachers edit them; the AI's Japanese is a draft to be checked.

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
**Teacher:** welcome screen → pick the word set → **Host for a class (two phones)** → share the QR code or link. **Students:** scan/open it on their phones, enter a name and a group number (same number = same pair, max two players).

- **State lives in shared storage, not in the server process** (`src/lib/class/service.ts`). On Vercel that is Upstash Redis (REST, plain `fetch`); locally, with no Upstash variables, an in-memory store is used. Every request is self-contained, so any serverless instance can serve any phone.
- **Concurrency:** a change is read → applied by the pure rules (`engine.ts`) → written with an atomic version check; if another request got there first it is re-applied to the fresh state. Duplicate submissions are ignored (per-request ids).
- **Security:** the seat (and so the role) comes from a random per-phone token (only its hash is stored), never from the URL. The Taker's responses never contain the word, definition, example, accepted answers or hints; the Giver only gets the current word; finished words keep only their name.
- **Presence & cost:** each poll is 3 storage commands every 2.5 s (6 s when the tab is hidden). A 30-phone, 45-minute class is roughly 100K commands.

## Teacher passcode
`TEACHER_PASSCODE` protects the Teacher Studio (OpenAI usage) and class-link creation (`x-teacher-passcode` header, 10 wrong guesses per 10 minutes then locked out). On Vercel the teacher tools are **locked** if it is not set. Students never need it.

## Deploying to Vercel
1. Import the GitHub repo in Vercel (project name `vocabulary-quiz-show`).
2. In the project: **Storage → Marketplace → Upstash Redis** (free plan), connect it to the project (adds the Redis variables).
3. Add environment variables (Production): `TEACHER_PASSCODE` (required), `OPENAI_API_KEY` (optional, for live AI).
4. Deploy. Open the production URL → **Teacher Studio / Host for a class** → enter the passcode → share the QR code.

## Voice: listening and speaking
- **Hearing words and hints (Giver):** the browser's built-in speech synthesis (free, offline). `src/lib/speech.ts` ranks the device's voices (natural/enhanced and well-known clear English voices first, novelty voices never), reads "____" as "blank", and allows only ONE playback at a time — starting another stops the first, pressing the playing button again stops it. Hints can be played once revealed (unrevealed hints cost points, so they stay hidden).
- **Speaking an answer (Taker):** a microphone button next to the answer box uses the browser's speech recognition (`src/lib/dictation.ts`). It starts only when pressed (that is when the permission prompt appears), listens to one short utterance, puts the words in the box for the student to edit, and NEVER submits. No audio is recorded or stored by the app; the browser's speech service (Google for Chrome, Apple for Safari) may process the audio.
- **Needs HTTPS on phones.** Microphone features require a secure context. `http://localhost` counts as secure; `http://192.168.x.x` (the classroom LAN link) does NOT — there the button explains this and typing / the keyboard's own microphone key still work.

## Giver illustration (a last-resort hint)

Illustrations are **not** shown automatically and nothing is drawn in advance. The Giver can press **"I need an illustration"** (after a confirmation: "An illustration will reduce the available score to 25 points"). Then:

- the server (not the browser) checks that the caller is the Giver and decides the word from the room's own state;
- a picture already made for that activity + word is reused (made in Teacher Studio, or drawn earlier); only if there is none, ONE image is drawn with the existing OpenAI setup (`OPENAI_API_KEY`; `OPENAI_IMAGE_MODEL`, default `gpt-image-1-mini`, low quality) and cached in Redis (`vqs:img:<activity>:<word>`, 24 h). A short lock (`vqs:imglock:…`) keeps simultaneous requests from drawing twice;
- only after a picture is available is the cap applied, atomically on the room: the word is worth at most **25** (English) / **13** (Japanese), whatever text hints were used; the Giver still gets half of the Taker's points (13 / 7, halves round up). Refreshing, reconnecting or asking again changes nothing; a failed drawing costs nothing;
- the picture is sent only to the Giver's phone, only for the word in play, only after the request. The Taker only learns that the word is now worth less.

In demo mode (one screen, no server room) the same button uses a picture made in Studio, or the teacher-protected Studio route. Teacher Studio can still pre-draw pictures ("Draw picture (AI)") so they can be reused without a second image call; they are never shown without the request. `OPENAI_IMAGES_URL` (server env, for tests only) replaces the OpenAI images endpoint.
