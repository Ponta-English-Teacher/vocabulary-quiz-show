/**
 * SERVER-SIDE OPENAI SWITCH. Vocabulary Quiz Show gets its questions from JSON files imported into the Word Bank, so every
 * OpenAI request (Studio question generation, Japanese translation, pictures; teacher-, student- or automatically-triggered)
 * is OFF unless the server environment says, exactly, VQS_OPENAI_ENABLED=true. Having OPENAI_API_KEY set is NOT enough.
 *
 * Two layers use this:
 *  1. Every server entry point reads the key through `openAIKey()`, so with the switch off the app behaves exactly as it
 *     already does without a key (Studio uses its free mock AI, pictures and translations report "not available").
 *  2. The two functions that actually contact OpenAI (`callOpenAIJson`, `generateIllustration`) refuse to use the real
 *     network while the switch is off, as a backstop for any code path that might bypass layer 1.
 * The "Use free mock" button in the Studio is a convenience only; it is not what protects against cost.
 */
export const OPENAI_SWITCH = "VQS_OPENAI_ENABLED";

export const OPENAI_DISABLED_MESSAGE =
  "OpenAI is turned off in Vocabulary Quiz Show. Questions come from JSON files imported into the Word Bank. Nothing was sent to OpenAI.";

type Env = Record<string, string | undefined>;

export function openAIEnabled(env: Env = process.env): boolean {
  return env[OPENAI_SWITCH] === "true";
}

/** The OpenAI key, but only when OpenAI is switched on. Every server entry point uses this instead of reading OPENAI_API_KEY. */
export function openAIKey(env: Env = process.env): string | undefined {
  return openAIEnabled(env) && env.OPENAI_API_KEY ? env.OPENAI_API_KEY : undefined;
}
