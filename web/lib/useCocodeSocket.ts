import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "./config";
import type { GeoPoint } from "./geolocation";
import type { InboundMessage, LocationKind, LocationState, Role } from "./types";

export type ConnectionStatus = "connecting" | "open" | "closed";
export type EndedReason = { kind: "manual" | "ttl" } | null;

// CocodeSocketState: セッション接続中にフックが管理する状態全体。
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

// 切断時に再接続を試みるまでの待機時間。
const RECONNECT_DELAY_MS = 2000;

/**
 * Owns the single WebSocket connection for a session (spec §4, §7): sends
 * the auth frame, keeps target/liveA/liveB in sync as broadcasts arrive,
 * and exposes a function to push this client's own location updates.
 *
 * 1つのセッションに対する WebSocket コネクションを管理するフック（仕様書§4, §7）。
 * 認証フレームの送信、サーバーからのブロードキャストに応じた
 * target/liveA/liveB の同期、自分側の位置情報更新を送信する関数の提供を行う。
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
  // 「意図的に閉じた（アンマウント、または回復不能なエラー）」かどうかを
  // 追跡し、この場合は自動再接続をしないようにするフラグ。
  const closedByUser = useRef(false);

  useEffect(() => {
    if (!sessionId || !token) return;
    closedByUser.current = false;

    // connect は WebSocket を1本張り、認証・メッセージ受信・再接続を仕込む。
    function connect() {
      const ws = new WebSocket(`${WS_BASE_URL}/ws`);
      wsRef.current = ws;
      setState((s) => ({ ...s, status: "connecting" }));

      // 接続確立後、真っ先に認証フレーム（sessionId, token）を送る。
      ws.onopen = () => {
        ws.send(JSON.stringify({ sessionId, token }));
        setState((s) => ({ ...s, status: "open" }));
      };

      // サーバーからのメッセージ種別ごとに状態を更新する。
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
            // セッションが消失した（不正なトークン、既に失効済みなど）ため、
            // 再接続しても無駄なので諦める。
            closedByUser.current = true;
            break;
        }
      };

      // 切断時、意図的な切断でなければ一定時間後に再接続を試みる。
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

    // クリーンアップ: アンマウント/依存値変更時は再接続させずに接続を閉じる。
    return () => {
      closedByUser.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [sessionId, token]);

  // sendLocationUpdate は自分側の位置情報更新をサーバーへ送信する。
  // 接続が確立していない場合は何もしない。
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
