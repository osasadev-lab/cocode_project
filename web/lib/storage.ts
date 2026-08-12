import { LOCAL_STORAGE_KEY } from "./config";

// Persists just enough for A to resume the same session after a reload on
// the same device (spec §5.1, §10-1). B never gets anything written here —
// their token only ever lives in the share-link URL.
export interface StoredSession {
  sessionId: string;
  token: string;
  expiresAt: string; // ISO 8601, used to avoid resuming an already-expired session
  shareUrl: string; // kept so A can find the invite link again after a reload
}

export function saveSession(s: StoredSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(s));
}

export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      clearSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
}
