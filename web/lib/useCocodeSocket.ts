import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "./config";
import type { GeoPoint } from "./geolocation";
import type { InboundMessage, LocationKind, LocationState, Role } from "./types";

export type ConnectionStatus = "connecting" | "open" | "closed";
export type EndedReason = { kind: "manual" | "ttl" } | null;

interface CocodeSocketState {
  status: ConnectionStatus;
  role: Role | null;
  target: LocationState | null;
  liveA: LocationState | null;
  liveB: LocationState | null;
  expiresAt: string | null;
  peerOnline: boolean;
  ended: EndedReason;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Owns the single WebSocket connection for a session (spec §4, §7): sends
 * the auth frame, keeps target/liveA/liveB in sync as broadcasts arrive,
 * and exposes a function to push this client's own location updates.
 */
export function useCocodeSocket(sessionId: string | null, token: string | null) {
  const [state, setState] = useState<CocodeSocketState>({
    status: "connecting",
    role: null,
    target: null,
    liveA: null,
    liveB: null,
    expiresAt: null,
    peerOnline: false,
    ended: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUser = useRef(false);

  useEffect(() => {
    if (!sessionId || !token) return;
    closedByUser.current = false;

    function connect() {
      const ws = new WebSocket(`${WS_BASE_URL}/ws`);
      wsRef.current = ws;
      setState((s) => ({ ...s, status: "connecting" }));

      ws.onopen = () => {
        ws.send(JSON.stringify({ sessionId, token }));
        setState((s) => ({ ...s, status: "open" }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as InboundMessage;
        switch (msg.type) {
          case "sync":
            setState((s) => ({
              ...s,
              role: msg.role,
              target: msg.target,
              liveA: msg.liveA ?? null,
              liveB: msg.liveB ?? null,
              expiresAt: msg.expiresAt,
              peerOnline: msg.peerOnline,
            }));
            break;
          case "peer_location":
            setState((s) => {
              if (msg.kind === "target") {
                return { ...s, target: { lat: msg.lat, lng: msg.lng, updatedAt: msg.updatedAt } };
              }
              const loc: LocationState = {
                lat: msg.lat,
                lng: msg.lng,
                accuracy: msg.accuracy,
                updatedAt: msg.updatedAt,
              };
              return msg.role === "a" ? { ...s, liveA: loc } : { ...s, liveB: loc };
            });
            break;
          case "peer_joined":
            setState((s) => ({ ...s, peerOnline: true }));
            break;
          case "peer_left":
            setState((s) => ({ ...s, peerOnline: false }));
            break;
          case "session_ended":
            setState((s) => ({ ...s, ended: { kind: "manual" } }));
            break;
          case "session_expired":
            setState((s) => ({ ...s, ended: { kind: "ttl" } }));
            break;
          case "error":
            // The session vanished (bad token, already expired, etc.) — no
            // point reconnecting.
            closedByUser.current = true;
            break;
        }
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, status: "closed" }));
        if (closedByUser.current) return;
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      closedByUser.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [sessionId, token]);

  const sendLocationUpdate = useCallback((kind: LocationKind, point: GeoPoint) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "location_update",
        kind,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
      })
    );
  }, []);

  return { ...state, sendLocationUpdate };
}
