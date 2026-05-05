/**
 * Recent pages — a sessionStorage-backed list of the last RECENT_CAP wiki
 * pages the user opened. Used by the sidebar launcher to surface a quick
 * "where was I" jump-list without round-tripping to the worker.
 *
 * sessionStorage (not localStorage) because recents are scoped to the
 * current browser tab/session and shouldn't survive a Paperclip restart.
 */

const STORAGE_KEY = "llm-wiki:recent";

export const RECENT_CAP = 8;

export interface RecentEntry {
  slug: string;
  title: string;
}

function isEntry(v: unknown): v is RecentEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.slug === "string" && typeof e.title === "string";
}

export function readRecent(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEntry).slice(0, RECENT_CAP);
}

export function recordRecent(entry: RecentEntry): void {
  if (typeof window === "undefined") return;
  if (typeof entry.slug !== "string" || entry.slug.length === 0) return;
  const current = readRecent();
  const next: RecentEntry[] = [
    { slug: entry.slug, title: entry.title },
    ...current.filter((e) => e.slug !== entry.slug),
  ].slice(0, RECENT_CAP);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sessionStorage may be disabled / full; recents are best-effort.
  }
}

export function clearRecent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}
