"use client";

import { useState } from "react";
import { MapView } from "./MapView";
import { AvatarPicker } from "./AvatarPicker";
import { TransportPicker } from "./TransportPicker";
import { DestinationPickerPanel } from "./DestinationPickerPanel";
import { DEFAULT_AVATAR_ICON } from "@/lib/avatars";
import { createSession } from "@/lib/api";
import { useDestinationPicker } from "@/lib/useDestinationPicker";
import { useLiveLocation } from "@/lib/geolocation";
import { useTransportEtaOptions } from "@/lib/useTransportEtaOptions";
import type { LocationState, TransportMode } from "@/lib/types";

interface CreateFormProps {
  onCreated: (
    sessionId: string,
    token: string,
    participantId: string,
    shareUrl: string,
    transportMode: TransportMode,
    expiresAt: string
  ) => void;
  /** 「トップ画面に戻る」押下時に呼ばれる(2026-08-31新設)。 */
  onCancel: () => void;
}

/**
 * ホストの入口画面。セッション（＝共有リンク）が存在する前に、
 * ここで待ち合わせ地点を選んでおく必要がある — 仕様書§5.1/§5.2/§10-4により、
 * 待ち合わせ地点が未設定のままリンクを発行することは意図的に禁止されている。
 *
 * 入力順(2026-08-31再改訂): 最初のステップは**表示名・アイコンのみ**。移動手段は
 * 地図を見ながら選べるよう、目的地確定パネル(「この地点で共有リンクを作成」)の
 * 直前に移した — 目的地が決まる前に移動手段だけ先に選ばせても、ホストは地図を
 * 見ていないため判断材料が無いため。
 *
 * 目的地の指定方法は`useDestinationPicker`(2026-08-31新設)に集約し、
 * 目的地変更(LiveSession)と全く同じ流れを共有する — いずれの方式で選んでも、
 * 最終的に地図タップで微調整・確定できるpicking画面へ合流する。
 */
export function CreateForm({ onCreated, onCancel }: CreateFormProps) {
  const picker = useDestinationPicker();
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [avatarIcon, setAvatarIcon] = useState(DEFAULT_AVATAR_ICON);
  const [transportMode, setTransportMode] = useState<TransportMode>("walk");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 移動手段選択時に目安所要時間も表示するため(2026-08-31新設、ゲスト参加時・
  // フッターの変更と共通のUI)、目的地確定パネルに到達してからホストの現在地を
  // 取得する(それより前に位置情報の許可を求めないようenabledで制御)。
  const { point: myPoint } = useLiveLocation(profileConfirmed);
  const myLive: LocationState | null = myPoint
    ? { lat: myPoint.lat, lng: myPoint.lng, accuracy: myPoint.accuracy, updatedAt: new Date().toISOString() }
    : null;
  const previewTarget: LocationState | null = picker.point
    ? { lat: picker.point.lat, lng: picker.point.lng, updatedAt: new Date().toISOString() }
    : null;
  // Reactのフックのルール上、条件分岐(下記の!profileConfirmed時の早期return)より
  // 前で呼び出す必要がある。
  const { etaByMode } = useTransportEtaOptions(myLive, previewTarget);

  // submitProfile: 表示名・アイコン・移動手段を確定し、目的地設定ステップへ進む。
  function submitProfile() {
    if (displayName.trim() === "") {
      setProfileError("表示名を入力してください");
      return;
    }
    setProfileError(null);
    setProfileConfirmed(true);
  }

  // confirm: 選択した地点でセッションを作成し、ローカル保存の上、親へ通知する。
  async function confirm() {
    if (!picker.point) return;
    setCreating(true);
    setError(null);
    try {
      const res = await createSession(
        picker.point.lat,
        picker.point.lng,
        picker.point.address ?? "",
        displayName.trim(),
        avatarIcon
      );
      onCreated(res.sessionId, res.tokenHost, res.participantId, res.shareUrl, transportMode, res.expiresAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "セッションの作成に失敗しました。時間をおいて再度お試しください。");
      setCreating(false);
    }
  }

  if (!profileConfirmed) {
    return (
      <div className="cocode-screen">
        <div className="cocode-modal-backdrop">
          <div className="cocode-glass cocode-form-card">
            <p className="cocode-subtitle">まずはあなたのプロフィールを入力してください。</p>

            <label className="cocode-hint" htmlFor="cocode-display-name">
              表示名(20文字以内)
            </label>
            <input
              id="cocode-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
              placeholder="例: たろう"
              className="cocode-text-input"
            />
            <label className="cocode-hint">アイコン</label>
            <AvatarPicker value={avatarIcon} onChange={setAvatarIcon} />
            {profileError && <p className="cocode-error">{profileError}</p>}

            <button className="cocode-btn cocode-btn-primary" onClick={submitProfile}>
              次へ(待ち合わせ場所を決める)
            </button>
            <button className="cocode-btn cocode-btn-secondary" onClick={onCancel}>
              トップ画面に戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cocode-screen">
      <MapView
        target={previewTarget}
        participants={[]}
        pickingTarget={picker.step === "picking"}
        onPickTarget={picker.handleMapPick}
        flyToTargetSignal={picker.flyToSignal}
      />

      <DestinationPickerPanel
        picker={picker}
        title="待ち合わせ場所を決めましょう。方法を選んでください。"
        confirmLabel={creating ? "作成中…" : "この地点で共有リンクを作成"}
        confirming={creating}
        onConfirm={confirm}
      >
        <label className="cocode-hint">移動手段</label>
        <TransportPicker value={transportMode} onChange={setTransportMode} etaByMode={etaByMode} />
        {error && <p className="cocode-error">{error}</p>}
      </DestinationPickerPanel>
    </div>
  );
}
