"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Unlock, Zap, ShieldCheck, MapPin, Menu as MenuIcon } from "lucide-react";
import { Button, Modal } from "@heroui/react";
import { AdSlot } from "./AdSlot";
import { Sidebar, type SidebarModalKind } from "./Sidebar";

// ホスト用トップページ(ランディングページ、仕様書§14.0)。
// 共有リンクなし・復元セッションなしでアクセスした際の入口。
// ゲストはこのページを経由しない(ゲスト専用のLandingGuestを別途用意、§14.2)。
//
// 2026-08-31改訂: スマートフォンでの利用を前提に、ヒーロー1画面で完結する
// 構成へ全面刷新。「使い方」はCTAボタン群の一番下に配置しモーダル表示、
// 「プライバシーと安全性」「安心のセキュリティ」はヘッダーのハンバーガー
// メニュー(左サイドバー、Sidebar.tsx)へ移動した。サイドバーには新設の
// 「サービスについて」、別タブで開く「よくある質問」「プライバシーポリシー」
// 「利用規約」も並ぶ(AdSense審査対策として実体のあるコンテンツページを用意)。
//
// 2026-09-02改訂: HeroUIを導入し絵文字を廃止(lucide-reactアイコンへ置き換え)。
interface LandingHostProps {
  onStart: () => void;
}

const FEATURES = [
  { icon: Unlock, label: "アカウント登録不要", tone: "violet" as const },
  { icon: Zap, label: "リアルタイム更新", tone: "brand" as const },
  { icon: ShieldCheck, label: "プライバシー保護", tone: "blue" as const },
];

// ヒーービジュアル(2026-09-02全面刷新): 「複数人が1つの待ち合わせ地点に
// 集まる」というcocodeの本質をそのまま表現するため、実際のアバターアイコン
// 3個が中央の目的地ピンへ向かって集まるアニメーションにした(globals.cssの
// 「ヒーービジュアル」セクション参照)。startX/startYは開始位置への
// オフセット(px)、ringは合流時のリング色(MapView.tsxのPARTICIPANT_COLORS
// と同じ配色から抜粋)、delayは合流タイミングを少しずらして人が集まってくる
// 自然さを出すための開始遅延(秒)。
//
// ring(2026-09-02改訂): 当初アイコンごとに固定していたが、「背景(リング色)は
// ランダムに振り分けよう」との指定により、表示のたびにシャッフルするよう
// 変更した(下記HeroRingsコンポーネント参照)。アイコン自体(src)・開始位置・
// 合流タイミングは固定のまま、リング色の組み合わせだけを毎回入れ替える。
const HERO_RING_COLORS: ("a" | "b" | "c")[] = ["a", "b", "c"];

const HERO_AVATARS: { id: string; src: string; startX: string; startY: string; delay: string }[] = [
  { id: "hud_player_pink", src: "/avatars/hud_player_pink.png", startX: "-92px", startY: "-58px", delay: "0s" },
  { id: "hud_player_blue", src: "/avatars/hud_player_blue.png", startX: "-78px", startY: "56px", delay: "0.25s" },
  { id: "hud_player_green", src: "/avatars/hud_player_green.png", startX: "92px", startY: "-14px", delay: "0.5s" },
];

// シャッフルは常にHERO_RING_COLORSの並び(a,b,c)から開始する既定値でレンダーし
// (静的書き出し(output: "export")のためサーバー/クライアントで結果が食い違う
// Math.random()を初期レンダーに使うとハイドレーション不整合になる)、
// マウント後のuseEffect内でのみランダムに並べ替える。
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const STEPS = [
  "表示名・アイコンを入力",
  "目的地を設定(現在地/地図タップ/住所検索)",
  "共有URLを友達に送る(QRコード可)",
  "リアルタイムで位置情報を共有",
];

type ModalKind = SidebarModalKind | null;

export function LandingHost({ onStart }: LandingHostProps) {
  const [modal, setModal] = useState<ModalKind>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // heroRingColors: 表示のたびにリング色をランダムに振り分ける(2026-09-02新設)。
  // 既定値(a,b,c)のままサーバー/初回レンダーを描画し、マウント後にだけ
  // シャッフルすることでハイドレーション不整合を避ける。
  const [heroRingColors, setHeroRingColors] = useState<("a" | "b" | "c")[]>(HERO_RING_COLORS);
  useEffect(() => {
    setHeroRingColors(shuffle(HERO_RING_COLORS));
  }, []);

  return (
    <div className="cocode-landing">
      <header className="cocode-landing-header">
        <img src="/brand/logo.png" alt="" className="cocode-landing-logo" />
        <span className="cocode-brand">cocode</span>
        <Button
          variant="outline"
          isIconOnly
          aria-label="メニューを開く"
          className="ml-auto"
          onPress={() => setSidebarOpen(true)}
        >
          <MenuIcon className="size-4.5" aria-hidden />
        </Button>
      </header>

      <section className="cocode-landing-hero">
        <h1 className="cocode-landing-headline">
          今いる場所を、<span className="cocode-landing-headline-accent">大切な人</span>とリアルタイムで共有
        </h1>

        <div className="cocode-hero-visual" aria-hidden>
          <div className="cocode-hero-glow" />
          <div className="cocode-hero-pin-pulse" />
          <div className="cocode-hero-pin-wrap">
            <MapPin className="cocode-hero-pin" size={30} fill="currentColor" />
          </div>
          {HERO_AVATARS.map((a, i) => (
            <div
              key={a.id}
              className="cocode-hero-avatar-wrap"
              style={{ "--start-x": a.startX, "--start-y": a.startY, "--start-delay": a.delay } as CSSProperties}
            >
              <div className={`cocode-hero-avatar cocode-hero-avatar-ring-${heroRingColors[i]}`}>
                <img src={a.src} alt="" className="cocode-hero-avatar-icon" />
              </div>
            </div>
          ))}
        </div>

        <div className="cocode-landing-features">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.label} className="cocode-landing-feature">
                <span className={`cocode-landing-feature-icon cocode-tone-${f.tone}`} aria-hidden>
                  <Icon className="size-5" />
                </span>
                <span className="cocode-landing-feature-label">{f.label}</span>
              </div>
            );
          })}
        </div>

        <div className="cocode-landing-cta-group">
          <Button variant="primary" size="lg" fullWidth onPress={onStart}>
            共有を開始する
          </Button>
          <Button variant="outline" size="lg" fullWidth onPress={() => setModal("how")}>
            使い方を見る
          </Button>
        </div>

        {/* 広告エリア(仕様書§15.1)。パブリッシャーID未設定の間はプレースホルダーのまま。 */}
        <AdSlot />
      </section>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenModal={(k) => {
          setSidebarOpen(false);
          setModal(k);
        }}
      />

      <Modal isOpen={modal !== null} onOpenChange={(open) => !open && setModal(null)}>
        <Modal.Backdrop>
          <Modal.Container scroll="inside">
            <Modal.Dialog>
              {modal === "about" && (
                <>
                  <Modal.Header>
                    <Modal.Heading>サービスについて</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="flex flex-col gap-3 text-sm text-muted">
                    <p>
                      cocodeは、待ち合わせや外出時に、大切な人と今いる場所をリアルタイムに共有できるWebアプリです。友人との待ち合わせはもちろん、お子さんの下校時の見守りや、旅行先でのグループ行動など、様々な場面でご利用いただけます。
                    </p>
                    <p>
                      アカウント登録は一切不要です。目的地を決めて共有リンクを発行するだけで、友達はそのリンクを開くだけですぐに参加できます。共有は1時間で自動的に終了するため、使い終わった後の管理も必要ありません。
                    </p>
                  </Modal.Body>
                </>
              )}
              {modal === "how" && (
                <>
                  <Modal.Header>
                    <Modal.Heading>使い方</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body>
                    <ol className="cocode-landing-steps-list">
                      {STEPS.map((s, i) => (
                        <li key={s}>
                          <span className="cocode-landing-step-num">{i + 1}</span>
                          {s}
                        </li>
                      ))}
                    </ol>
                  </Modal.Body>
                </>
              )}
              {modal === "privacy" && (
                <>
                  <Modal.Header>
                    <Modal.Heading>プライバシーと安全性</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="flex flex-col gap-3 text-sm text-muted">
                    <p>
                      共有リンクは、推測が困難なランダムな文字列(セッショントークン)で保護されています。このリンクを知っている人だけが、そのセッションに参加し、参加者の位置情報を見ることができます。
                    </p>
                    <p>
                      位置情報は共有中のみサーバー上で保持され、共有が終了(手動終了、または1時間の期限切れ)すると削除されます。アカウント登録を行わないため、個人を特定できる情報を継続的に保持することもありません。
                    </p>
                    <p>より詳しい内容は、メニューの「プライバシーポリシー」をご覧ください。</p>
                  </Modal.Body>
                </>
              )}
              {modal === "security" && (
                <>
                  <Modal.Header>
                    <Modal.Heading>安心のセキュリティ</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="flex flex-col gap-3 text-sm text-muted">
                    <p>cocodeとブラウザ間、およびサーバー間の通信は、すべてHTTPS/WSSにより暗号化されています。</p>
                    <p>セッションへのアクセスは、推測困難なトークンを持つ端末のみに制限されており、第三者が総当たりでセッションに侵入することは実質的に困難です。</p>
                    <p>ただし、共有リンク自体を第三者に転送すると、その相手も参加者の位置情報を閲覧できてしまいます。信頼できる相手にのみ共有リンクを送付するようにしてください。</p>
                  </Modal.Body>
                </>
              )}
              {modal === "ads" && (
                <>
                  <Modal.Header>
                    <Modal.Heading>広告について</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="flex flex-col gap-3 text-sm text-muted">
                    <p>cocodeは無料でご利用いただけるサービスです。サーバー運用等の費用の一部として、トップページにGoogle AdSenseによる広告を表示しています。</p>
                    <p>表示される広告はコンテンツと明確に区別される位置に配置しており、地図・位置情報共有の画面には広告を表示しません。</p>
                  </Modal.Body>
                </>
              )}
              <Modal.Footer>
                <Button variant="outline" onPress={() => setModal(null)}>
                  閉じる
                </Button>
              </Modal.Footer>
              <Modal.CloseTrigger />
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
