"use client";

import { useEffect, useState } from "react";
import { MapView } from "./MapView";
import { CountdownBadge } from "./CountdownBadge";
import { StatusCard } from "./StatusCard";
import { EndedModal } from "./EndedModal";
import { ShareLinkCard } from "./ShareLinkCard";
import { useCocodeSocket } from "@/lib/useCocodeSocket";
import { useLiveLocation, type GeoPoint } from "@/lib/geolocation";
import { useTrail } from "@/lib/useTrail";
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

function toLocationState(p: GeoPoint | null): LocationState | null {
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, accuracy: p.accuracy, updatedAt: new Date().toISOString() };
}

export function LiveSession({ sessionId, token, shareUrl }: LiveSessionProps) {
  const socket = useCocodeSocket(sessionId, token);
  const { point: myPoint } = useLiveLocation(true);
  const [pickingTarget, setPickingTarget] = useState(false);
  const [ending, setEnding] = useState(false);
  const [localEnded, setLocalEnded] = useState(false);
  // A's own re-picked meeting point, shown immediately without waiting for
  // a round trip — the hub only broadcasts target updates to B (spec §7),
  // so A's own screen would otherwise never reflect a re-pick.
  const [myTargetOverride, setMyTargetOverride] = useState<LocationState | null>(null);

  // Resend our current fix whenever it changes AND whenever the socket
  // (re)opens, so a fix obtained before the handshake finished isn't lost.
  useEffect(() => {
    if (!myPoint || socket.status !== "open") return;
    socket.sendLocationUpdate("live", myPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPoint, socket.status]);

  const myLive = toLocationState(myPoint);
  const liveA = socket.role === "a" ? myLive : socket.liveA;
  const liveB = socket.role === "b" ? myLive : socket.liveB;
  const target = socket.role === "a" ? (myTargetOverride ?? socket.target) : socket.target;

  const trailA = useTrail(liveA);
  const trailB = useTrail(liveB);

  function handlePickTarget(lat: number, lng: number) {
    const point: GeoPoint = { lat, lng, accuracy: 0 };
    socket.sendLocationUpdate("target", point);
    setMyTargetOverride({ lat, lng, updatedAt: new Date().toISOString() });
    setPickingTarget(false);
  }

  async function handleEnd() {
    setEnding(true);
    try {
      await endSession(sessionId, token);
      clearSession();
      setLocalEnded(true);
    } catch {
      setEnding(false);
    }
  }

  const ended = localEnded ? { kind: "manual" as const } : socket.ended ? { kind: socket.ended.kind } : null;

  const peerLabel = socket.role === "a" ? "ユーザーB" : "ユーザーA";
  const peerLastUpdated = socket.role === "a" ? socket.liveB?.updatedAt : socket.liveA?.updatedAt;
  const showShareCard = socket.role === "a" && shareUrl && !socket.peerOnline;

  return (
    <div className="cocode-screen">
      <MapView
        target={target}
        liveA={liveA}
        liveB={liveB}
        trailA={trailA}
        trailB={trailB}
        pickingTarget={pickingTarget}
        onPickTarget={handlePickTarget}
      />

      <div className="cocode-topbar">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
          {socket.role === "a" && (
            <button
              className="cocode-fab cocode-fab-primary"
              title="待ち合わせ地点を再設定"
              onClick={() => setPickingTarget((v) => !v)}
            >
              {pickingTarget ? "✕" : "📍"}
            </button>
          )}
          <button
            className="cocode-fab"
            style={{ background: "var(--danger)", color: "white" }}
            title="共有を終了"
            onClick={handleEnd}
            disabled={ending}
          >
            ⏹
          </button>
        </div>
      </div>

      {ended && <EndedModal reason={ended.kind} />}
    </div>
  );
}
