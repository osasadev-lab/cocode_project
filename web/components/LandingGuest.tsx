"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronUp, Map as MapIcon } from "lucide-react";
import { Alert, Button, Card, Input, Label, Switch } from "@heroui/react";
import { AdSlot } from "./AdSlot";
import { AvatarPicker } from "./AvatarPicker";
import { TransportPicker } from "./TransportPicker";
import { MapView } from "./MapView";
import { avatarIconSrc, DEFAULT_AVATAR_ICON } from "@/lib/avatars";
import { ApiError, getGuestPreview } from "@/lib/api";
import { useLiveLocation } from "@/lib/geolocation";
import { useTransportEtaOptions } from "@/lib/useTransportEtaOptions";
import { NotFoundScreen } from "./NotFoundScreen";
import type { GuestPreview, LocationState, TransportMode } from "@/lib/types";

interface LandingGuestProps {
  sessionId: string;
  token: string;
  /** 表示名・アイコン・移動手段・位置情報共有の可否をすべて確定して「この内容で
   * 参加する」を押した時点で初めて呼ばれる(2026-08-31改訂)。それまではWebSocket
   * 接続(=参加登録)自体を行わない — 移動手段を選んでいる途中の段階で、他の
   * 参加者から見て「参加済み」として数えられてしまう不具合があったため、
   * 参加確定は最後の一度だけにした。
   * locationSharing(2026-09-02新設): falseの場合、参加直後から自分の位置情報を
   * 共有しない(LiveSession側の切り替えでいつでもオンに戻せる)。 */
  onJoin: (displayName: string, avatarIcon: string, transportMode: TransportMode, locationSharing: boolean) => void;
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
  // 位置情報オフモード(2026-09-02新設、共有開始前に選択できるようにする)。
  // 既定はオン — cocodeの主目的が位置共有であるため。
  const [locationSharing, setLocationSharing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // panelCollapsed(2026-09-02新設): この経路確認カードは内容が多く縦に長いため、
  // 画面の狭いスマートフォンでは地図・目的地ピンをほぼ覆い隠してしまう
  // (「目的地が表示されていない」という指摘の実体はこれだった)。カード右上の
  // シェブロンボタンで、地図を確認できる小さなピル状のボタンだけに折りたためる
  // ようにする。
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // 現在地は最終ステップに到達してから取得する(それより前に位置情報の許可を求めないため)。
  // locationSharingがオフの間は、最終ステップに到達していても許可自体を求めない
  // (2026-09-02追加)。
  // highAccuracy=false(2026-09-02新設): この画面は経路プレビュー・ETA目安の
  // 表示が目的で、GPSの厳密な精度より現在地の表示速度を優先する(§geolocation.ts参照)。
  const { point: myPoint } = useLiveLocation(step === "transport" && locationSharing, false);
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
    onJoin(displayName.trim(), avatarIcon, transportMode, locationSharing);
  }

  if (step === "transport") {
    return (
      <div className="cocode-screen">
        <MapView
          target={previewTarget}
          participants={
            myLive
              ? [
                  {
                    id: "preview-self",
                    lat: myLive.lat,
                    lng: myLive.lng,
                    label: displayName || "あなた",
                    avatarSrc: avatarIconSrc(avatarIcon),
                    isSelf: true,
                    transportMode,
                    arrived: false,
                  },
                ]
              : []
          }
          // refitOnGrowth(2026-09-02新設): 目的地は参加登録前から分かっている
          // 一方、自分の現在地はGPS取得を待つ必要があり数秒遅れて届く。この画面の
          // 目的は「現在地から目的地までの経路を見てもらう」ことなので、現在地が
          // 後から加わった時点で両方が画面に収まるよう再フィットさせる。
          refitOnGrowth
        />
        <div className="cocode-topbar">
          {panelCollapsed ? (
            // variant="outline"(縁取りのみ・背景透明)は、カードの中でなく地図に
            // 直接重ねると背景・文字とも地図に溶け込んで読めなくなる。ヘッダー/
            // フッター(LiveSession.tsx)と同じ不透明なガラス調背景に統一する
            // (2026-09-02修正、ユーザーフィードバックにより他UIとの統一を優先し
            // 当初のprimary(青塗り)から変更)。
            <Button
              variant="ghost"
              onPress={() => setPanelCollapsed(false)}
              className="gap-2 border border-border bg-surface/90 shadow-lg backdrop-blur-sm"
            >
              <MapIcon className="size-4" aria-hidden />
              地図を確認中(タップで再表示)
            </Button>
          ) : (
            <Card className="flex w-full max-w-85 flex-col gap-3 p-4.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-muted">
                  {previewTarget ? "現在地から目的地までの経路です。移動手段を選んでください。" : "目的地の情報を読み込んでいます…"}
                </p>
                <Button
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  onPress={() => setPanelCollapsed(true)}
                  className="shrink-0"
                  aria-label="地図を確認するため折りたたむ"
                >
                  <ChevronUp className="size-4" aria-hidden />
                </Button>
              </div>
              <TransportPicker value={transportMode} onChange={setTransportMode} etaByMode={etaByMode} />
              {!myLive && locationSharing && <p className="text-xs text-muted">現在地を取得できると、経路と所要時間が表示されます。</p>}

              <Switch isSelected={locationSharing} onChange={setLocationSharing}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  位置情報を共有する
                </Switch.Content>
              </Switch>
              <p className="-mt-1.5 text-xs leading-relaxed text-muted">
                オフにすると、参加後もあなたの現在地は相手に共有されません(あとからいつでも切り替えられます)。
              </p>

              <Button variant="primary" onPress={confirmJoin}>
                この内容で参加する
              </Button>
              <Button variant="outline" onPress={() => setStep("profile")}>
                戻る
              </Button>
            </Card>
          )}
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
          <Card className="flex w-full flex-col gap-2.5 p-4.5 text-left">
            {preview.destAddress && (
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted">目的地</span>
                <strong>{preview.destAddress}</strong>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted">現在の参加人数</span>
              <strong>{preview.participantCount ?? 0}人</strong>
            </div>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted">有効期限</span>
              <strong>{new Date(preview.expiresAt).toLocaleString("ja-JP")}</strong>
            </div>
          </Card>
        ) : (
          <p className="text-sm text-muted">読み込み中…</p>
        )}

        <Alert status="warning" className="text-left">
          <Alert.Indicator>
            <AlertTriangle className="size-4.5" aria-hidden />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Description>
              このリンクは信頼できる相手から送られたものですか？共有リンクを知っている人は誰でも参加者全員の現在地を見ることができます。
            </Alert.Description>
          </Alert.Content>
        </Alert>

        {step === "invite" ? (
          <Button variant="primary" size="lg" fullWidth onPress={() => setStep("profile")} isDisabled={!preview}>
            参加する
          </Button>
        ) : (
          <Card className="flex w-full max-w-90 flex-col gap-4.5 p-7">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cocode-guest-display-name">表示名(20文字以内)</Label>
              <Input
                id="cocode-guest-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
                placeholder="例: はなこ"
                fullWidth
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>アイコン</Label>
              <AvatarPicker value={avatarIcon} onChange={setAvatarIcon} />
            </div>
            <Button variant="primary" onPress={submitProfile}>
              次へ(経路を確認して移動手段を選ぶ)
            </Button>
            {error && <p className="text-sm text-danger">{error}</p>}
          </Card>
        )}

        {/* 広告エリア(仕様書§15.1)。パブリッシャーID未設定の間はプレースホルダーのまま。 */}
        <AdSlot />
      </section>
    </div>
  );
}
