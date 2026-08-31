"use client";

import { useEffect, useState } from "react";
import { AdSlot } from "./AdSlot";
import { AvatarPicker } from "./AvatarPicker";
import { TransportPicker } from "./TransportPicker";
import { MapView } from "./MapView";
import { DEFAULT_AVATAR_ICON } from "@/lib/avatars";
import { ApiError, getGuestPreview } from "@/lib/api";
import { useLiveLocation } from "@/lib/geolocation";
import { useTransportEtaOptions } from "@/lib/useTransportEtaOptions";
import { NotFoundScreen } from "./NotFoundScreen";
import type { GuestPreview, LocationState, TransportMode } from "@/lib/types";

interface LandingGuestProps {
  sessionId: string;
  token: string;
  /** 表示名・アイコン・移動手段をすべて確定して「この内容で参加する」を
   * 押した時点で初めて呼ばれる(2026-08-31改訂)。それまではWebSocket接続
   * (=参加登録)自体を行わない — 移動手段を選んでいる途中の段階で、他の
   * 参加者から見て「参加済み」として数えられてしまう不具合があったため、
   * 参加確定は最後の一度だけにした。 */
  onJoin: (displayName: string, avatarIcon: string, transportMode: TransportMode) => void;
}

type Step = "invite" | "profile" | "transport";

// ゲスト用トップページ(仕様書§14.2)。初回参加(localStorageにparticipantIdが
// 無い)ゲストが共有リンクを開いた際に表示される。
//
// 2026-08-31改訂: 表示名・アイコンに続けて、参加確定前の最終ステップとして
// 「現在地→目的地の全体経路を見ながら移動手段を選ぶ」画面を挟む
// (ゲストが全体像を把握した上で選べるようにするため)。この時点ではまだ
// 参加登録(WebSocket接続)を行っていない — ゲスト用プレビューAPIが目的地の
// 座標を返すようになった(2026-08-31)ことで、参加前でも地図を描画できる。
export function LandingGuest({ sessionId, token, onJoin }: LandingGuestProps) {
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [step, setStep] = useState<Step>("invite");
  const [displayName, setDisplayName] = useState("");
  const [avatarIcon, setAvatarIcon] = useState(DEFAULT_AVATAR_ICON);
  const [transportMode, setTransportMode] = useState<TransportMode>("walk");
  const [error, setError] = useState<string | null>(null);

  // 現在地は最終ステップに到達してから取得する(それより前に位置情報の許可を求めないため)。
  const { point: myPoint } = useLiveLocation(step === "transport");
  const myLive: LocationState | null = myPoint
    ? { lat: myPoint.lat, lng: myPoint.lng, accuracy: myPoint.accuracy, updatedAt: new Date().toISOString() }
    : null;
  const previewTarget: LocationState | null =
    preview && step === "transport" ? { lat: preview.destLat, lng: preview.destLng, updatedAt: new Date().toISOString() } : null;
  const { etaByMode } = useTransportEtaOptions(myLive, previewTarget);

  useEffect(() => {
    let cancelled = false;
    getGuestPreview(sessionId, token)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          setNotFound(true);
        } else {
          setNotFound(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  if (notFound) return <NotFoundScreen />;

  function submitProfile() {
    if (displayName.trim() === "") {
      setError("表示名を入力してください");
      return;
    }
    setError(null);
    setStep("transport");
  }

  function confirmJoin() {
    onJoin(displayName.trim(), avatarIcon, transportMode);
  }

  if (step === "transport") {
    return (
      <div className="cocode-screen">
        <MapView
          target={previewTarget}
          participants={
            myLive
              ? [{ id: "preview-self", lat: myLive.lat, lng: myLive.lng, label: displayName || "あなた", isSelf: true, transportMode, arrived: false }]
              : []
          }
        />
        <div className="cocode-topbar">
          <div className="cocode-glass cocode-form-card cocode-picking-card">
            <p className="cocode-hint">
              {previewTarget ? "現在地から目的地までの経路です。移動手段を選んでください。" : "目的地の情報を読み込んでいます…"}
            </p>
            <TransportPicker value={transportMode} onChange={setTransportMode} etaByMode={etaByMode} />
            {!myLive && <p className="cocode-hint">現在地を取得できると、経路と所要時間が表示されます。</p>}
            <button className="cocode-btn cocode-btn-primary" onClick={confirmJoin}>
              この内容で参加する
            </button>
            <button className="cocode-btn cocode-btn-secondary" onClick={() => setStep("profile")}>
              戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cocode-landing cocode-landing-guest">
      <header className="cocode-landing-header">
        <img src="/brand/logo.png" alt="" className="cocode-landing-logo" />
        <span className="cocode-brand">cocode</span>
      </header>

      <section className="cocode-landing-hero cocode-landing-hero-guest">
        <h1 className="cocode-landing-headline">位置共有への招待が届いています</h1>

        {preview ? (
          <div className="cocode-glass cocode-invite-card">
            {preview.destAddress && (
              <div className="cocode-invite-row">
                <span className="cocode-hint">目的地</span>
                <strong>{preview.destAddress}</strong>
              </div>
            )}
            <div className="cocode-invite-row">
              <span className="cocode-hint">現在の参加人数</span>
              <strong>{preview.participantCount}人</strong>
            </div>
            <div className="cocode-invite-row">
              <span className="cocode-hint">有効期限</span>
              <strong>{new Date(preview.expiresAt).toLocaleString("ja-JP")}</strong>
            </div>
          </div>
        ) : (
          <p className="cocode-hint">読み込み中…</p>
        )}

        <p className="cocode-trust-notice">
          ⚠️ このリンクは信頼できる相手から送られたものですか？共有リンクを知っている人は誰でも参加者全員の現在地を見ることができます。
        </p>

        {step === "invite" ? (
          <button
            className="cocode-btn cocode-btn-primary cocode-landing-cta"
            onClick={() => setStep("profile")}
            disabled={!preview}
          >
            参加する
          </button>
        ) : (
          <div className="cocode-glass cocode-form-card" style={{ width: "100%", maxWidth: 360 }}>
            <label className="cocode-hint" htmlFor="cocode-guest-display-name">
              表示名(20文字以内)
            </label>
            <input
              id="cocode-guest-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
              placeholder="例: はなこ"
              className="cocode-text-input"
            />
            <label className="cocode-hint">アイコン</label>
            <AvatarPicker value={avatarIcon} onChange={setAvatarIcon} />
            <button className="cocode-btn cocode-btn-primary" onClick={submitProfile}>
              次へ(経路を確認して移動手段を選ぶ)
            </button>
            {error && <p className="cocode-error">{error}</p>}
          </div>
        )}

        {/* 広告エリア(仕様書§15.1)。パブリッシャーID未設定の間はプレースホルダーのまま。 */}
        <AdSlot />
      </section>
    </div>
  );
}
