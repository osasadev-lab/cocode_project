// Shared shapes mirroring the Go backend's JSON (see server/internal/session
// and server/internal/hub). Keeping these in one file makes it obvious when
// the frontend and backend protocols drift apart.
//
// Go バックエンドの JSON（server/internal/session, server/internal/hub 参照）に
// 対応する型定義を1ファイルにまとめている。こうしておくことで、
// フロントエンドとバックエンドのプロトコルにズレが生じた際に気付きやすくなる。

export type Role = "a" | "b";
export type LocationKind = "target" | "live";

// LocationState: ある時点での位置情報（待ち合わせ地点、またはライブ位置）。
export interface LocationState {
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string; // ISO 8601
}

// CreateSessionResponse: POST /api/sessions のレスポンス（REST API）。
export interface CreateSessionResponse {
  sessionId: string;
  tokenA: string;
  shareUrl: string;
  expiresAt: string;
}

// SessionState: GET /api/sessions/:id/state のレスポンス（再同期時に使用）。
export interface SessionState {
  role: Role;
  expiresAt: string;
  target: LocationState;
  liveA?: LocationState;
  liveB?: LocationState;
}

// -- WebSocket protocol (spec §7) --
// -- WebSocket プロトコル（仕様書§7）ここから --

// クライアント → サーバー方向のメッセージ。
export interface OutboundLocationUpdate {
  type: "location_update";
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
}

// サーバー → クライアント方向のメッセージ。接続直後に届く初回同期フレーム。
export interface InboundSync {
  type: "sync";
  role: Role;
  expiresAt: string;
  target: LocationState;
  liveA?: LocationState;
  liveB?: LocationState;
  peerOnline: boolean;
}

// 相手側の位置情報（待ち合わせ地点 or ライブ位置）が更新された通知。
export interface InboundPeerLocation {
  type: "peer_location";
  role: Role;
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string;
}

// 相手が接続/切断したことの通知。
export interface InboundRoleEvent {
  type: "peer_joined" | "peer_left";
  role: Role;
}

// セッションが終了（手動終了 or TTL失効）したことの通知。
export interface InboundReasonEvent {
  type: "session_ended" | "session_expired";
  reason: string;
}

// エラー通知（不正なトークン、セッション消失など）。
export interface InboundErrorEvent {
  type: "error";
  message: string;
}

// サーバーから届きうる全メッセージのユニオン型。
export type InboundMessage =
  | InboundSync
  | InboundPeerLocation
  | InboundRoleEvent
  | InboundReasonEvent
  | InboundErrorEvent;
