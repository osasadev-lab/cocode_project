import { LOCAL_STORAGE_KEY } from "./config";

// Persists just enough for A to resume the same session after a reload on
// the same device (spec §5.1, §10-1). B never gets anything written here —
// their token only ever lives in the share-link URL.
// 同じ端末でのリロード後に A が同じセッションを再開できるよう、
// 必要最小限の情報を localStorage に永続化する（仕様書§5.1, §10-1）。
// B の情報はここには書き込まれない。B のトークンは共有リンクの URL にのみ存在する。
export interface StoredSession {
  sessionId: string;
  token: string;
  expiresAt: string; // ISO 8601, used to avoid resuming an already-expired session
  shareUrl: string; // kept so A can find the invite link again after a reload
}

// saveSession はセッション情報を localStorage に保存する（SSR環境では何もしない）。
export function saveSession(s: StoredSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(s));
}

// loadSession は保存済みセッションを読み込む。既に期限切れなら破棄して null を返す。
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

// clearSession は保存済みセッション情報を削除する。
export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
}
