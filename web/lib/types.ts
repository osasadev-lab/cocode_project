// Shared shapes mirroring the Go backend's JSON (see server/internal/session
// and server/internal/hub). Keeping these in one file makes it obvious when
// the frontend and backend protocols drift apart.

export type Role = "a" | "b";
export type LocationKind = "target" | "live";

export interface LocationState {
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string; // ISO 8601
}

export interface CreateSessionResponse {
  sessionId: string;
  tokenA: string;
  shareUrl: string;
  expiresAt: string;
}

export interface SessionState {
  role: Role;
  expiresAt: string;
  target: LocationState;
  liveA?: LocationState;
  liveB?: LocationState;
}

// -- WebSocket protocol (spec §7) --

export interface OutboundLocationUpdate {
  type: "location_update";
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
}

export interface InboundSync {
  type: "sync";
  role: Role;
  expiresAt: string;
  target: LocationState;
  liveA?: LocationState;
  liveB?: LocationState;
  peerOnline: boolean;
}

export interface InboundPeerLocation {
  type: "peer_location";
  role: Role;
  kind: LocationKind;
  lat: number;
  lng: number;
  accuracy?: number;
  updatedAt: string;
}

export interface InboundRoleEvent {
  type: "peer_joined" | "peer_left";
  role: Role;
}

export interface InboundReasonEvent {
  type: "session_ended" | "session_expired";
  reason: string;
}

export interface InboundErrorEvent {
  type: "error";
  message: string;
}

export type InboundMessage =
  | InboundSync
  | InboundPeerLocation
  | InboundRoleEvent
  | InboundReasonEvent
  | InboundErrorEvent;

// A single point recorded for the client-side-only route trail (spec §5.4:
// never persisted server-side, purely for the current page's lifetime).
export interface TrailPoint {
  lat: number;
  lng: number;
}
