// バックエンドの REST API（server/internal/api）を呼び出すクライアント関数群。
import { API_BASE_URL } from "./config";
import type { CreateSessionResponse, GuestPreview, RegenerateLinkResponse, RouteStep, SessionState, TransitEtaResponse } from "./types";

// ApiError は REST API がエラーレスポンスを返した際に投げる例外。
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// apiFetch は fetch() 自体の失敗(サーバーに到達できない・オフライン・CORS等)を
// ApiError へ変換する薄いラッパー。fetch()が投げる例外はブラウザ・実行環境
// ごとに文言がバラバラ("Failed to fetch"/"NetworkError when attempting to
// fetch resource"/"Load failed"等)な上、そのままではAPIサーバーがエラー
// レスポンスを返したときと見分けが付かず、いずれもユーザーには何が起きたか
// 伝わらない生の技術的文言だった(2026-09-02修正)。ここで一律にユーザー向けの
// 文言へ変換し、呼び出し元(各コンポーネントのcatch節)は常にApiError.message
// を表示すればよいようにする。HTTPレベルのエラー(4xx/5xx)は従来通りhandle()
// が個別に処理するため、ここでは「fetch自体が失敗した」場合のみを対象にする。
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiError(0, "サーバーに接続できません。ネットワーク環境をご確認の上、時間をおいて再度お試しください。");
  }
}

// handle は fetch のレスポンスを検証し、失敗時は ApiError を投げ、
// 成功時は JSON をパースして返す共通処理。
//
// validate(2026-09-02新設): 成功レスポンスの実行時型検証。これまでJSONを
// `as T` で無条件にキャストしていたため、想定と異なる形のJSON(サーバー側の
// バグ、あるいはtoken_hostがゲスト用プレビューの形を期待する呼び出し元へ
// 誤って別形状のレスポンスを返してしまうようなケース、§5.8参照)が返っても
// 気づけず、呼び出し元が`undefined`のプロパティを静かに読み続けてしまう
// リスクがあった。各APIごとの軽量なガード関数(下記is*系)を渡すことで、
// 形が合わない場合はここでApiErrorとして検出する。省略時(void応答等)は
// 従来通り検証しない。
async function handle<T>(res: Response, validate?: (v: unknown) => v is T): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // レスポンスボディが JSON でなければ statusText にフォールバックする
    }
    throw new ApiError(res.status, message);
  }
  // ボディが空の成功レスポンス(204 No Content、および201 Createdでも
  // ボディを返さないエンドポイントがある — POST /api/feedback等)は
  // res.json()が空文字のパースに失敗して例外を投げてしまうため、
  // ステータスコードで決め打ちせずボディの中身自体で判定する
  // (2026-08-31修正: フィードバック送信が実際には成功しているのに
  // 「送信に失敗しました」と表示されてしまう不具合の対応)。
  const text = await res.text();
  if (text === "") return undefined as T;
  const parsed = JSON.parse(text) as unknown;
  if (validate && !validate(parsed)) {
    throw new ApiError(res.status, "サーバーからの応答が不正な形式です。時間をおいて再度お試しください。");
  }
  return parsed as T;
}

// isRecord は値がプレーンなオブジェクト(配列・nullを除く)かどうかを判定する、
// 以下のis*ガード関数群の共通ヘルパー。
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCreateSessionResponse(v: unknown): v is CreateSessionResponse {
  return (
    isRecord(v) &&
    typeof v.sessionId === "string" &&
    typeof v.tokenHost === "string" &&
    typeof v.participantId === "string" &&
    typeof v.shareUrl === "string" &&
    typeof v.expiresAt === "string"
  );
}

function isGuestPreview(v: unknown): v is GuestPreview {
  return (
    isRecord(v) &&
    (v.destAddress === undefined || typeof v.destAddress === "string") &&
    typeof v.destLat === "number" &&
    typeof v.destLng === "number" &&
    typeof v.participantCount === "number" &&
    typeof v.expiresAt === "string"
  );
}

function isSessionState(v: unknown): v is SessionState {
  return (
    isRecord(v) &&
    (v.role === "host" || v.role === "guest") &&
    typeof v.participantId === "string" &&
    isRecord(v.destination) &&
    typeof v.expiresAt === "string" &&
    Array.isArray(v.participants)
  );
}

function isRegenerateLinkResponse(v: unknown): v is RegenerateLinkResponse {
  return isRecord(v) && typeof v.tokenHost === "string" && typeof v.shareUrl === "string" && typeof v.expiresAt === "string";
}

function isTransitEtaResponse(v: unknown): v is TransitEtaResponse {
  return isRecord(v) && typeof v.etaSeconds === "number" && typeof v.polyline === "string" && Array.isArray(v.steps);
}

/** セッションを作成する。目的地・表示名・アイコンはいずれも必須（仕様書§5.1, §6, §6.1）
 * — ホストがこれらを決めるまで共有リンクは発行されない。 */
export async function createSession(
  lat: number,
  lng: number,
  address: string,
  displayName: string,
  avatarIcon: string
): Promise<CreateSessionResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng, address, displayName, avatarIcon }),
  });
  return handle<CreateSessionResponse>(res, isCreateSessionResponse);
}

/** ゲスト用トップページ(§14.2)向けのプレビューを取得する。参加者登録は行わず、
 * 他参加者の個人情報も含まない最小限の情報のみ返る(§5.5)。 */
export async function getGuestPreview(sessionId: string, token: string): Promise<GuestPreview> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/state?token=${encodeURIComponent(token)}`;
  const res = await apiFetch(url);
  return handle<GuestPreview>(res, isGuestPreview);
}

/** セッション状態を再取得する。WebSocket が接続（またはリロード後に再接続）
 * する前に、UI へ初期状態を反映させるために使う。participantId 指定が必須
 * （未指定だとgetGuestPreviewと同じ簡易プレビュー形状が返ってしまうため）。 */
export async function getSessionState(sessionId: string, token: string, participantId: string): Promise<SessionState> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/state?token=${encodeURIComponent(token)}&participantId=${encodeURIComponent(participantId)}`;
  const res = await apiFetch(url);
  return handle<SessionState>(res, isSessionState);
}

/** ホストが全参加者に対して即座にセッションを終了させる（仕様書§5.6・§5.8）。
 * participantIdはホスト自身のもの — token_hostだけを知る第三者からの呼び出しを
 * 404として拒否するための一致確認に使う(2026-09-02改訂)。 */
export async function endSession(sessionId: string, token: string, participantId: string): Promise<void> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/end?token=${encodeURIComponent(token)}&participantId=${encodeURIComponent(participantId)}`;
  const res = await apiFetch(url, { method: "POST" });
  await handle<void>(res);
}

/** ゲストが明示的に退出する(新設)。アクティブなWebSocket接続を持たない状態
 * (§ResumeSessionChoice、共有中にトップページへアクセスして「退出する」を
 * 選んだ場合)でも、復帰猶予(10分)を待たず即座に恒久退出できるようにする
 * 安全弁。ライブ共有画面での「退出する」(WebSocket接続あり)は引き続き
 * useCocodeSocketのleave()を使う — こちらはその代替経路。 */
export async function leaveSession(sessionId: string, token: string, participantId: string): Promise<void> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/leave?token=${encodeURIComponent(token)}&participantId=${encodeURIComponent(participantId)}`;
  const res = await apiFetch(url, { method: "POST" });
  await handle<void>(res);
}

/** ホスト/ゲスト双方のトークンを新しい値へ差し替える(新設)。誤ってブラウザの
 * アドレスバーのURL(ホスト自身のトークン入り)を共有してしまった等、トークン
 * 漏えいが疑われる場合にホストが呼ぶ安全弁。古いトークンは以後の新規参加・
 * 再接続に使えなくなる(既に接続済みのWebSocketはこの呼び出し単体では
 * 切断されない)。 */
export async function regenerateLink(sessionId: string, token: string): Promise<RegenerateLinkResponse> {
  const url = `${API_BASE_URL}/api/sessions/${sessionId}/regenerate-link?token=${encodeURIComponent(token)}`;
  const res = await apiFetch(url, { method: "POST" });
  return handle<RegenerateLinkResponse>(res, isRegenerateLinkResponse);
}

/** 電車モードのETA・経路を取得する（仕様書§7.1〜§7.1.3、Phase 7で使用）。
 * NAVITIME/ジョルダンいずれのAPIキーもフロントエンドへは露出しない
 * — このバックエンド経由の呼び出しのみで完結する。 */
export async function computeTransitEta(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<TransitEtaResponse> {
  const res = await apiFetch(`${API_BASE_URL}/api/eta/transit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromLat, fromLng, toLat, toLng }),
  });
  return handle<TransitEtaResponse>(res, isTransitEtaResponse);
}

/** フィードバックを送信する（仕様書§17.1〜§17.2、Phase 6で使用）。 */
export async function submitFeedback(message: string, replyTo?: string): Promise<void> {
  const res = await apiFetch(`${API_BASE_URL}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, replyTo }),
  });
  await handle<void>(res);
}

// RouteStep を再エクスポートしておくと、api.ts だけをimportしている箇所からも
// 型を参照できて便利なため(TransitEtaResponse内で使用)。
export type { RouteStep };
