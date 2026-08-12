"use client";

import { useState } from "react";
import { MapView } from "./MapView";
import { createSession } from "@/lib/api";
import { getCurrentPosition } from "@/lib/geolocation";
import { saveSession } from "@/lib/storage";
import type { LocationState } from "@/lib/types";

interface CreateFormProps {
  onCreated: (sessionId: string, token: string, shareUrl: string) => void;
}

/**
 * A's entry screen. The meeting point must be chosen here, before a
 * session (and therefore a share link) exists at all — spec §5.1/§5.2/§10-4
 * deliberately forbid issuing a link with no meeting point set yet.
 */
export function CreateForm({ onCreated }: CreateFormProps) {
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function useCurrentLocation() {
    setError(null);
    setLocating(true);
    try {
      const p = await getCurrentPosition();
      setPoint({ lat: p.lat, lng: p.lng });
    } catch (e) {
      setError(e instanceof Error ? e.message : "現在地を取得できませんでした");
    } finally {
      setLocating(false);
    }
  }

  async function confirm() {
    if (!point) return;
    setCreating(true);
    setError(null);
    try {
      const res = await createSession(point.lat, point.lng);
      saveSession({
        sessionId: res.sessionId,
        token: res.tokenA,
        expiresAt: res.expiresAt,
        shareUrl: res.shareUrl,
      });
      onCreated(res.sessionId, res.tokenA, res.shareUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "セッションの作成に失敗しました。時間をおいて再度お試しください。");
      setCreating(false);
    }
  }

  const previewTarget: LocationState | null = point
    ? { lat: point.lat, lng: point.lng, updatedAt: new Date().toISOString() }
    : null;

  return (
    <div className="cocode-screen">
      <MapView
        target={previewTarget}
        liveA={null}
        liveB={null}
        trailA={[]}
        trailB={[]}
        pickingTarget
        onPickTarget={(lat, lng) => setPoint({ lat, lng })}
      />

      <div className="cocode-topbar">
        <div className="cocode-glass cocode-form-card">
          <div className="cocode-brand">
            <span className="cocode-brand-dot" />
            cocode
          </div>
          <p className="cocode-subtitle">
            待ち合わせ場所を決めましょう。現在地を使うか、地図をタップして地点を指定してください。
          </p>

          <button className="cocode-btn cocode-btn-secondary" onClick={useCurrentLocation} disabled={locating}>
            {locating ? "取得中…" : "📍 現在地を使う"}
          </button>

          {point && (
            <>
              <hr className="cocode-divider" />
              <p className="cocode-hint">
                地点を選択しました({point.lat.toFixed(5)}, {point.lng.toFixed(5)})。この場所を待ち合わせ地点として共有を開始します。
              </p>
              <button className="cocode-btn cocode-btn-primary" onClick={confirm} disabled={creating}>
                {creating ? "作成中…" : "この地点で共有リンクを作成"}
              </button>
            </>
          )}

          {error && <p className="cocode-error">{error}</p>}

          <p className="cocode-hint">
            共有リンクを知っている人は誰でもお互いの位置情報を見ることができます。信頼できる相手にのみ送ってください。
          </p>
        </div>
      </div>
    </div>
  );
}
