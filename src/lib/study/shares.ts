import type { StorageLike } from "@/lib/studio/storage";

/**
 * The teacher's own record of the study pages they have published (kept in THIS browser only), so they can find the
 * link again and take a page down. The pages themselves live on the server, keyed by an unguessable token.
 */
export interface StudyShare {
  token: string;
  /** Where the words came from: a library list key, or "class:<id>" for a hosted class. */
  source: string;
  title: string;
  words: number;
  /** The full link students open. */
  url: string;
  createdAt: number;
  expiresAt: number;
}

export const SHARES_KEY = "vqs.studyShares.v1";

export function loadShares(storage: StorageLike | null, now = Date.now()): StudyShare[] {
  try {
    const raw = storage?.getItem(SHARES_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((s): s is StudyShare => !!s && typeof s.token === "string" && typeof s.source === "string" && typeof s.url === "string" && typeof s.expiresAt === "number" && s.expiresAt > now);
  } catch {
    return [];
  }
}

function save(storage: StorageLike | null, list: StudyShare[]) {
  try {
    storage?.setItem(SHARES_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the page still works, the teacher just won't see it listed */
  }
}

export function addShare(storage: StorageLike | null, share: StudyShare, now = Date.now()): StudyShare[] {
  const next = [share, ...loadShares(storage, now).filter((s) => s.token !== share.token)];
  save(storage, next);
  return next;
}

export function removeShare(storage: StorageLike | null, token: string, now = Date.now()): StudyShare[] {
  const next = loadShares(storage, now).filter((s) => s.token !== token);
  save(storage, next);
  return next;
}
