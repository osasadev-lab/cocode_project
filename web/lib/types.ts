// Go バックエンドの JSON（server/internal/session, server/internal/hub,
// server/internal/ws, server/internal/api 参照）に対応する型定義を1ファイルに
// まとめている。こうしておくことで、フロントエンドとバックエンドの
// プロトコルにズレが生じた際に気付きやすくなる。
//
// v2.0で1対多（ホスト+複数ゲスト）モデルへ移行したため、v1.0の
// Role="a"|"b"・liveA/liveB固定の構造から、Role="host"|"guest"・
// participantIdをキーにした構造へ全面的に置き換えた（仕様書§5.1, §5.4）。

export type Role = "host" | "guest";
export type LocationKind = "target" | "live";
export type TransportMode = "walk" | "car" | "train";

// LocationState: ある時点での位置情報（待ち合わせ地点、またはライブ位置）。
export interface LocationState {
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string; // ISO 8601
}

// RouteStep: 電車モードの経路区間（仕様書§7.1.1）。徒歩区間は駅名を持たない。
export interface RouteStep {
  kind: "walk" | "transit";
  distanceMeters?: number;
  line?: string;
  departureStop?: string;
  arrivalStop?: string;
  numStops?: number;
}

// ParticipantPublic: sync/state取得で配信される、参加者1人ぶんの公開情報。
export interface ParticipantPublic {
  id: string;
  role: Role;
  displayName: string;
  avatarIcon: string;
  transportMode: TransportMode;
  live: LocationState | null;
  etaSeconds: number | null;
  arrived: boolean;
  /** 電車モードの経路線(仕様書§7.1.1、2026-08-31実装)。NAVITIMEの経路形状を
   * 取得できた場合のみ設定される座標列(JSON文字列、[lng,lat]のペアの配列)。
   * 未設定/取得失敗時はMapView側が現在地→目的地の直線で代替表示する。 */
  routePolyline?: string;
  routeSteps?: RouteStep[];
}

export interface Destination {
  lat: number;
  lng: number;
  address?: string;
  updatedAt: string;
}

// LiveParticipant: 地図描画専用の1参加者ぶんの表示情報（自分を含む）。
// N人対応の地図描画（Phase 6§1）向けに、MapViewがparticipantId単位で
// マーカー・経路を管理できるようにするための最小限の形。transportModeは
// 経路線の描画プロファイル(徒歩/車)の切替に使う(電車は経路線を描画しない、
// §4は別タスク)。
export interface LiveParticipant {
  id: string;
  lat: number;
  lng: number;
  label: string;
  avatarSrc?: string;
  isSelf: boolean;
  transportMode: TransportMode;
  arrived: boolean;
  /** 電車モードの経路線(2026-08-31実装、ParticipantPublic.routePolyline参照)。 */
  routePolyline?: string;
}

// ActivityEntry: 右サイドバーのアクティビティログ1件ぶん(2026-08-31新設)。
// 「今から起きたこと」のみを記録する(sync受信時点で既に参加していた
// メンバーはログに含めない)。
export type ActivityKind = "joined" | "left" | "arrived" | "message";
export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  displayName: string;
  text?: string;
  at: string; // ISO 8601
}

// -- REST API --

// CreateSessionResponse: POST /api/sessions のレスポンス。
export interface CreateSessionResponse {
  sessionId: string;
  tokenHost: string;
  participantId: string;
  shareUrl: string;
  expiresAt: string;
}

// GuestPreview: GET /api/sessions/:id/state を participantId 未指定で呼んだ
// 際のレスポンス（ゲスト用トップページ§14.2向け、参加者登録を伴わない）。
export interface GuestPreview {
  destAddress?: string;
  /** 目的地の座標(2026-08-31追加)。参加確定前に現在地→目的地の全体経路を
   * 見せるために使う(LandingGuest.tsx参照)。 */
  destLat: number;
  destLng: number;
  participantCount: number;
  expiresAt: string;
}

// SessionState: GET /api/sessions/:id/state を participantId 指定で呼んだ
// 際のレスポンス（再同期時に使用）。
export interface SessionState {
  role: Role;
  participantId: string;
  destination: Destination;
  expiresAt: string;
  participants: ParticipantPublic[];
}

// TransitEtaResponse: POST /api/eta/transit のレスポンス（Phase 7で使用）。
export interface TransitEtaResponse {
  etaSeconds: number;
  polyline: string;
  steps: RouteStep[];
}

// -- WebSocket プロトコル（仕様書§5.4）ここから --

// クライアント → サーバー方向のメッセージ。
export interface OutboundLocationUpdate {
  type: "location_update";
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
  address?: string;
  transportMode?: TransportMode;
  etaSeconds?: number;
  routePolyline?: string;
  routeSteps?: RouteStep[];
}

export interface OutboundTransportUpdate {
  type: "transport_update";
  transportMode: TransportMode;
  etaSeconds?: number;
}

export interface OutboundProfileUpdate {
  type: "profile_update";
  displayName: string;
  avatarIcon: string;
}

export interface OutboundExpression {
  type: "expression";
  kind: "stamp" | "reaction";
  text?: string;
}

// サーバー → クライアント方向のメッセージ。接続直後に届く初回同期フレーム。
export interface InboundSync {
  type: "sync";
  role: Role;
  participantId: string;
  destination: Destination;
  expiresAt: string;
  participants: ParticipantPublic[];
}

// 新規ゲストが参加したことの通知（再接続時は届かない）。
export interface InboundParticipantJoined {
  type: "participant_joined";
  participant: Pick<ParticipantPublic, "id" | "role" | "displayName" | "avatarIcon" | "transportMode">;
}

// 誰かが切断したことの通知。
export interface InboundParticipantLeft {
  type: "participant_left";
  participantId: string;
  displayName: string;
}

// 誰か（自分以外）の位置情報（待ち合わせ地点 or ライブ位置）が更新された通知。
export interface InboundPeerLocation {
  type: "peer_location";
  participantId: string;
  role: Role;
  displayName: string;
  avatarIcon: string;
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
  address?: string;
  transportMode: TransportMode;
  etaSeconds: number | null;
  routePolyline?: string;
  routeSteps?: RouteStep[];
  updatedAt: string;
}

// 誰かが表示名・アイコンを変更した通知（共有中の変更、仕様書§14.5）。
export interface InboundParticipantUpdated {
  type: "participant_updated";
  participantId: string;
  displayName: string;
  avatarIcon: string;
  updatedAt: string;
}

// 誰かが目的地に到着した通知（仕様書§12.1-①）。
export interface InboundParticipantArrived {
  type: "participant_arrived";
  participantId: string;
  displayName: string;
  arrivedAt: string;
}

// スタンプ・アイコンリアクションの通知（仕様書§12.1-④⑤）。
export interface InboundPeerExpression {
  type: "peer_expression";
  participantId: string;
  displayName: string;
  avatarIcon: string;
  kind: "stamp" | "reaction";
  text: string;
  sentAt: string;
}

// セッションが終了（手動終了 or TTL失効）したことの通知。
export interface InboundReasonEvent {
  type: "session_ended" | "session_expired";
}

// エラー通知（不正なトークン、セッション消失、バリデーション失敗など）。
export interface InboundErrorEvent {
  type: "error";
  message: string;
}

// サーバーから届きうる全メッセージのユニオン型。
export type InboundMessage =
  | InboundSync
  | InboundParticipantJoined
  | InboundParticipantLeft
  | InboundPeerLocation
  | InboundParticipantUpdated
  | InboundParticipantArrived
  | InboundPeerExpression
  | InboundReasonEvent
  | InboundErrorEvent;
