/** What a student may see about one word. Deliberately small: no hints, no Giver notes, no pictures, no answers. */
export interface StudyWord {
  word: string;
  partOfSpeech: string;
  meaning: string;
  ja: string[];
  example: string;
}

export interface StudyView {
  title: string;
  words: StudyWord[];
  /** Epoch ms after which the page is gone. */
  expiresAt: number;
}
