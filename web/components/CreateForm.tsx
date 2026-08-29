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

type Step = "choose" | "picking";

/**
 * ユーザーA の入口画面。セッション（＝共有リンク）が存在する前に、
 * ここで待ち合わせ地点を選んでおく必要がある — 仕様書§5.1/§5.2/§10-4により、
 * 待ち合わせ地点が未設定のままリンクを発行することは意図的に禁止されている。
 *
 * 画面遷移: まずブロッキングモーダルの「choose」で方法（現在地 or 地図タップ）を選び、
 * 次に非ブロッキングの小さなカードに切り替わることで地図は常にタップ可能なままになる。
 * これにより、繰り返しタップしてもモーダルが毎回出ずにピンの位置だけが動く。
 */
export function CreateForm({ onCreated }: CreateFormProps) {
  const [step, setStep] = useState<Step>("choose");
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // useCurrentLocation: 現在地を取得し、待ち合わせ地点の候補として採用する。
  async function useCurrentLocation() {
    setError(null);
    setLocating(true);
    try {
      const p = await getCurrentPosition();
      setPoint({ lat: p.lat, lng: p.lng });
      setStep("picking");
    } catch (e) {
      setError(e instanceof Error ? e.message : "現在地を取得できませんでした");
    } finally {
      setLocating(false);
    }
  }

  // chooseFromMap: 「地図から選択する」を選んだ場合、地図タップ待ちの状態にする。
  function chooseFromMap() {
    setError(null);
    setStep("picking");
  }

  // reselect: 選択をやり直し、最初の方法選択画面に戻す。
  function reselect() {
    setPoint(null);
    setError(null);
    setStep("choose");
  }

  // confirm: 選択した地点でセッションを作成し、ローカル保存の上、親へ通知する。
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
        pickingTarget={step === "picking"}
        onPickTarget={(lat, lng) => setPoint({ lat, lng })}
      />

      {step === "choose" ? (
        <div className="cocode-modal-backdrop">
          <div className="cocode-glass cocode-form-card">
            <div className="cocode-brand">
              <span className="cocode-brand-dot" />
              cocode
            </div>
            <p className="cocode-subtitle">待ち合わせ場所を決めましょう。方法を選んでください。</p>

            <button className="cocode-btn cocode-btn-secondary" onClick={useCurrentLocation} disabled={locating}>
              {locating ? "取得中…" : "📍 現在地を使う"}
            </button>
            <button className="cocode-btn cocode-btn-secondary" onClick={chooseFromMap} disabled={locating}>
              🗺️ 地図から選択する
            </button>

            {error && <p className="cocode-error">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="cocode-topbar">
          <div className="cocode-glass cocode-form-card cocode-picking-card">
            {point ? (
              <p className="cocode-hint">
                地点を選択しました({point.lat.toFixed(5)}, {point.lng.toFixed(5)})。この場所を待ち合わせ地点として共有を開始します。
              </p>
            ) : (
              <p className="cocode-hint">地図をタップして待ち合わせ地点を指定してください。</p>
            )}

            {point && (
              <button className="cocode-btn cocode-btn-primary" onClick={confirm} disabled={creating}>
                {creating ? "作成中…" : "この地点で共有リンクを作成"}
              </button>
            )}

            <button className="cocode-btn cocode-btn-secondary" onClick={reselect} disabled={creating}>
              選びなおす
            </button>

            {error && <p className="cocode-error">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
