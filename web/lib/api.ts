// バックエンドの REST API（server/internal/api）を呼び出すクライアント関数群。
import { API_BASE_URL } from "./config";
import type { CreateSessionResponse, SessionState } from "./types";

// ApiError は REST API がエラーレスポンスを返した際に投げる例外。
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// handle は fetch のレスポンスを検証し、失敗時は ApiError を投げ、
// 成功時は JSON をパースして返す共通処理。
async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // response body wasn't JSON; fall back to statusText
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Creates a session. The meeting point is required (spec §5.1) — cocode
 * never issues a share link before A has set where to meet.
 * セッションを作成する。待ち合わせ地点は必須（仕様書§5.1）— cocode は
 * A が待ち合わせ場所を決めるまで共有リンクを発行しない。 */
export async function createSession(lat: number, lng: number): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng }),
  });
  return handle<CreateSessionResponse>(res);
}

/** Re-syncs session state, used to prime the UI before the WebSocket
 * connects (or reconnects after a reload).
 * セッション状態を再取得する。WebSocket が接続（またはリロード後に再接続）
 * する前に、UI へ初期状態を反映させるために使う。 */
export async function getSessionState(sessionId: string, token: string): Promise<SessionState> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/state?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  return handle<SessionState>(res);
}

/** Ends a session immediately for both participants (spec §5.5).
 * 両参加者に対して即座にセッションを終了させる（仕様書§5.5）。 */
export async function endSession(sessionId: string, token: string): Promise<void> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/end?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: "POST" });
  await handle<void>(res);
}
