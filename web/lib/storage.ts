import { GUEST_IDENTITY_STORAGE_KEY, LOCAL_STORAGE_KEY } from "./config";
import type { Role } from "./types";

// 同じ端末でのリロード後にホスト・ゲストいずれも同じセッションへ自動復帰
// できるよう、必要最小限の情報を localStorage に永続化する
// （仕様書§5.1, §10-1, §14.1ステップ7, §14.3ステップ5）。
//
// v1.0はA(ホスト相当)専用の保存だったが、v2.0では1対多モデルにより
// ゲストも再訪時の自動復帰が必要になったため、role・participantIdを
// 追加してホスト/ゲスト共通の形にした。
export interface StoredSession {
  sessionId: string;
  token: string; // ホストは tokenHost、ゲストは共有リンクの token
  participantId: string;
  role: Role;
  expiresAt: string; // ISO 8601。既に期限切れのセッションを再開しないための判定に使う
  shareUrl?: string; // ホストのみ保持(§14.1ステップ7)。リロード後も招待リンクを再取得できるようにする
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

// ゲストの再訪検知用ID(2026-08-31新設、不具合修正)。
//
// 「退出する」操作は StoredSession(アクティブなセッションへのポインタ、
// 上記のsaveSession/loadSession)をクリアするが、これとは独立して
// セッションID単位でゲストのparticipantIdを保持しておく。こうすることで、
// 一度退出したゲストが同じ招待リンクを再び開いた際に「同じ人物の再訪」と
// 認識でき、サーバー側(hub.Join)に毎回新しい参加者レコードを作らせずに
// 済む(退出→再参加のたびに参加人数が増え続け、地図上にも同一人物の
// マーカーが複数残ってしまう不具合の原因だった)。
interface GuestIdentityEntry {
  participantId: string;
  expiresAt: string;
}
type GuestIdentityMap = Record<string, GuestIdentityEntry>;

function readGuestIdentityMap(): GuestIdentityMap {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(GUEST_IDENTITY_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as GuestIdentityMap;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// 期限切れのエントリはついでに掃除しておく(無制限に溜め続けないため)。
function pruneExpired(map: GuestIdentityMap): GuestIdentityMap {
  const now = Date.now();
  const pruned: GuestIdentityMap = {};
  for (const [sessionId, entry] of Object.entries(map)) {
    if (new Date(entry.expiresAt).getTime() > now) pruned[sessionId] = entry;
  }
  return pruned;
}

function writeGuestIdentityMap(map: GuestIdentityMap): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(GUEST_IDENTITY_STORAGE_KEY, JSON.stringify(pruneExpired(map)));
}

// saveGuestIdentity はゲストのparticipantIdをセッションID単位で保存する。
export function saveGuestIdentity(sessionId: string, participantId: string, expiresAt: string): void {
  const map = readGuestIdentityMap();
  map[sessionId] = { participantId, expiresAt };
  writeGuestIdentityMap(map);
}

// loadGuestIdentity は指定セッションの保存済みparticipantIdを返す
// (期限切れ・未保存ならnull)。
export function loadGuestIdentity(sessionId: string): string | null {
  const map = pruneExpired(readGuestIdentityMap());
  return map[sessionId]?.participantId ?? null;
}

// clearGuestIdentity は指定セッションの保存済みparticipantIdを削除する
// (サーバー側で既に失効しており再利用できないと判明した場合に使う)。
export function clearGuestIdentity(sessionId: string): void {
  const map = readGuestIdentityMap();
  delete map[sessionId];
  writeGuestIdentityMap(map);
}
