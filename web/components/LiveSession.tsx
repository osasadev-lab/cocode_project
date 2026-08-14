"use client";

import { useEffect, useState } from "react";
import { MapView } from "./MapView";
import { CountdownBadge } from "./CountdownBadge";
import { StatusCard } from "./StatusCard";
import { SessionEndedScreen } from "./SessionEndedScreen";
import { NotFoundScreen } from "./NotFoundScreen";
import { ShareLinkCard } from "./ShareLinkCard";
import { useCocodeSocket } from "@/lib/useCocodeSocket";
import { useLiveLocation, type GeoPoint } from "@/lib/geolocation";
import { endSession } from "@/lib/api";
import { clearSession } from "@/lib/storage";
import type { LocationState } from "@/lib/types";

interface LiveSessionProps {
  sessionId: string;
  token: string;
  /** Only set right after A creates the session on this device — shown so
   * A can copy the invite link again before B has joined. */
  shareUrl?: string;
}

// toLocationState は GeoPoint（ブラウザの Geolocation API 由来）を
// サーバーとやり取りする LocationState 形式へ変換する。
function toLocationState(p: GeoPoint | null): LocationState | null {
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, accuracy: p.accuracy, updatedAt: new Date().toISOString() };
}

// LiveSession: セッション参加中（地図・相手の状態・終了操作）のメイン画面。
export function LiveSession({ sessionId, token, shareUrl }: LiveSessionProps) {
  const socket = useCocodeSocket(sessionId, token);
  const { point: myPoint } = useLiveLocation(true);
  const [ending, setEnding] = useState(false);
  const [localEnded, setLocalEnded] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  // Resend our current fix whenever it changes AND whenever the socket
  // (re)opens, so a fix obtained before the handshake finished isn't lost.
  // 自分の位置が変化した時、および WebSocket が（再）接続した時の両方で
  // 現在の位置を送り直す。これにより、認証ハンドシェイク完了前に取得した
  // 位置情報が失われないようにする。
  useEffect(() => {
    if (!myPoint || socket.status !== "open") return;
    socket.sendLocationUpdate("live", myPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPoint, socket.status]);

  // 自分の役割に応じて、自分の位置は myLive を、相手の位置は socket 経由の
  // 値を採用する（自分の位置はサーバーの反響を待たず即座に表示するため）。
  const myLive = toLocationState(myPoint);
  const liveA = socket.role === "a" ? myLive : socket.liveA;
  const liveB = socket.role === "b" ? myLive : socket.liveB;
  const target = socket.target;

  // handleEnd: 「終了する」確定時、セッションを終了させローカル状態を掃除する。
  async function handleEnd() {
    setEnding(true);
    setEndError(null);
    try {
      await endSession(sessionId, token);
      clearSession();
      setLocalEnded(true);
    } catch (e) {
      setEnding(false);
      setEndError(e instanceof Error ? e.message : "共有の終了に失敗しました。時間をおいて再度お試しください。");
    }
  }

  const ended = localEnded ? { kind: "manual" as const } : socket.ended ? { kind: socket.ended.kind } : null;

  // Once the session is over there's nothing left to show on the map, so
  // each side gets its own dedicated full screen instead of a modal over a
  // dead map: A (who has the context of having shared/ended it) sees a
  // proper "ended" screen, B (who only ever held a link) sees a plain
  // not-found — same treatment a dead link gets anywhere else.
  // セッション終了後は地図に表示すべきものが何も無いため、死んだ地図の上に
  // モーダルを重ねるのではなく、それぞれ専用の全画面表示に切り替える。
  // A（自分が共有・終了した経緯を知っている）には正式な「終了しました」画面を、
  // B（リンクしか持っていない）には他の失効リンクと同様の404画面を見せる。
  if (ended) {
    return socket.role === "a" ? <SessionEndedScreen reason={ended.kind} /> : <NotFoundScreen />;
  }

  const peerLabel = socket.role === "a" ? "ユーザーB" : "ユーザーA";
  const peerLastUpdated = socket.role === "a" ? socket.liveB?.updatedAt : socket.liveA?.updatedAt;
  const showShareCard = socket.role === "a" && shareUrl && !socket.peerOnline;

  return (
    <div className="cocode-screen">
      <MapView target={target} liveA={liveA} liveB={liveB} />

      <div className="cocode-topbar">
        <div className="cocode-topbar-cards">
          <StatusCard peerLabel={peerLabel} online={socket.peerOnline} lastUpdatedAt={peerLastUpdated} />
          {showShareCard && <ShareLinkCard shareUrl={shareUrl!} />}
        </div>
        {socket.expiresAt && <CountdownBadge expiresAt={socket.expiresAt} />}
      </div>

      <div className="cocode-bottombar">
        <div className="cocode-legend cocode-glass">
          <span className="cocode-legend-item">
            <span className="cocode-legend-swatch" style={{ background: "var(--accent-a)" }} />
            ユーザーA
          </span>
          <span className="cocode-legend-item">
            <span className="cocode-legend-swatch" style={{ background: "var(--accent-b)" }} />
            ユーザーB
          </span>
        </div>

        <div className="cocode-fab-group">
          <button
            className="cocode-fab"
            style={{ background: "var(--danger)", color: "white" }}
            title="共有を終了"
            onClick={() => setConfirmingEnd(true)}
            disabled={ending}
          >
            ⏹
          </button>
        </div>
      </div>

      {confirmingEnd && (
        <div className="cocode-modal-backdrop">
          <div className="cocode-glass cocode-modal">
            <div className="cocode-modal-icon">⏹</div>
            <p className="cocode-modal-title">共有を終了しますか?</p>
            <p className="cocode-modal-body">
              終了すると、{peerLabel}との位置共有がすぐに終わります。この操作は取り消せません。
            </p>
            {endError && <p className="cocode-error">{endError}</p>}
            <button className="cocode-btn cocode-btn-primary" onClick={handleEnd} disabled={ending}>
              {ending ? "終了中…" : "終了する"}
            </button>
            <button
              className="cocode-btn cocode-btn-secondary"
              onClick={() => {
                setConfirmingEnd(false);
                setEndError(null);
              }}
              disabled={ending}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
