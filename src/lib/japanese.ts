/**
 * Deterministic checking of a Japanese answer. No AI, no guessing at runtime:
 * an answer is correct only if it matches one of the teacher-approved equivalents stored with the word (`ja`)
 * after ordinary writing differences are normalised. A related word that is NOT on the list is wrong.
 *
 * Normalised away (so these all match the same entry):
 *  - hiragana / katakana ("ざる" = "ザル"), full-width / half-width forms ("ｻﾞﾙ", "ＤＶＤ" = "dvd")
 *  - spaces, punctuation, the middle dot and the long-vowel mark at the end ("コンピューター" = "コンピュータ")
 *  - polite or casual wrappers that speech recognition and students add: "えっと、ざるです" "それはざるだと思う"
 *
 * NOT normalised (teachers list these as separate equivalents): kanji vs. kana ("傘" vs "かさ"), verb conjugations,
 * synonyms. There is deliberately no fuzzy matching, so a typo is wrong rather than guessed.
 */

export type JapaneseVerdict = "correct" | "wrong" | "empty" | "not-japanese" | "unavailable";

const JAPANESE_CHARS = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

export const hasJapaneseChars = (s: string): boolean => JAPANESE_CHARS.test(s);

/** The comparison key for a Japanese string. */
export function normalizeJa(input: string): string {
  const folded = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const hira = folded.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return hira.replace(/ー+$/, "");
}

// Written in hiragana because normalizeJa() converts katakana first.
const LEADING_FILLERS = /^(?:えっと|えーと|えーっと|ええと|えっとー|あのー?|うーん|うん|んー|あー|ああ|あっ|それは|これは|あれは|たぶん|多分|きっと|もしかして|もしかしたら)+/;
const TRAILING_ENDINGS = [
  "だと思います", "だと思う", "かもしれません", "かもしれない", "でしょうか", "ではないでしょうか",
  "ですよね", "ですよ", "ですか", "でしょう", "だよね", "だっけ", "ですね", "です", "だよ", "かな", "かも", "だ",
].sort((a, b) => b.length - a.length);

/** The key itself, plus the key with leading fillers and/or one trailing copula removed. */
function candidates(key: string): string[] {
  const out = new Set<string>([key]);
  const noLead = key.replace(LEADING_FILLERS, "");
  const bases = noLead && noLead !== key ? [key, noLead] : [key];
  if (noLead) out.add(noLead);
  for (const b of bases) {
    for (const end of TRAILING_ENDINGS) {
      if (b.length > end.length && b.endsWith(end)) {
        out.add(b.slice(0, -end.length));
        break;
      }
    }
  }
  out.delete("");
  return [...out];
}

/** Does `guess` match one of the approved equivalents? */
export function matchesJapanese(guess: string, ja: readonly string[]): boolean {
  const targets = new Set(ja.map(normalizeJa).filter(Boolean));
  if (!targets.size) return false;
  const key = normalizeJa(guess);
  return candidates(key).some((c) => targets.has(c));
}

export function checkJapaneseAnswer(guess: string, ja: readonly string[] | undefined): JapaneseVerdict {
  if (!guess.trim()) return "empty";
  if (!ja || !ja.some((j) => normalizeJa(j))) return "unavailable";
  if (matchesJapanese(guess, ja)) return "correct";
  return hasJapaneseChars(guess) ? "wrong" : "not-japanese";
}

/** How to show the approved equivalents after the round ends: "ざる / 水切りざる". */
export function japaneseDisplay(ja: readonly string[] | undefined, max = 3): string {
  return (ja ?? []).filter((j) => j.trim()).slice(0, max).join(" / ");
}
