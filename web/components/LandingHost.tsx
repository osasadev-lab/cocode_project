"use client";

import { useState } from "react";
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
interface LandingHostProps {
  onStart: () => void;
}

const FEATURES = [
  { icon: "🔓", label: "アカウント登録不要", tone: "violet" as const },
  { icon: "⚡", label: "リアルタイム更新", tone: "brand" as const },
  { icon: "🛡️", label: "プライバシー保護", tone: "blue" as const },
];

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

  return (
    <div className="cocode-landing">
      <header className="cocode-landing-header">
        <img src="/brand/logo.png" alt="" className="cocode-landing-logo" />
        <span className="cocode-brand">cocode</span>
        <button
          className="cocode-sidebar-trigger"
          onClick={() => setSidebarOpen(true)}
          aria-label="メニューを開く"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <section className="cocode-landing-hero">
        <h1 className="cocode-landing-headline">
          今いる場所を、<span className="cocode-landing-headline-accent">大切な人</span>とリアルタイムで共有
        </h1>

        <div className="cocode-phone-mockup" aria-hidden>
          <div className="cocode-phone-glow" />
          <span className="cocode-phone-deco cocode-phone-deco-1">🌳</span>
          <div className="cocode-phone-frame">
            <div className="cocode-phone-notch" />
            <div className="cocode-phone-screen">
              <svg viewBox="0 0 220 200" className="cocode-phone-route" preserveAspectRatio="none">
                <path
                  id="cocode-route-path"
                  d="M36,168 C60,120 40,96 84,86 C128,76 118,44 176,28"
                  fill="none"
                  stroke="url(#cocode-route-grad)"
                  strokeWidth="4"
                  strokeDasharray="1 11"
                  strokeLinecap="round"
                />
                <defs>
                  <linearGradient id="cocode-route-grad" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" style={{ stopColor: "var(--brand-from)" }} />
                    <stop offset="1" style={{ stopColor: "var(--brand-to)" }} />
                  </linearGradient>
                </defs>
                {/* 経路上をループ移動する小さなドット。現在地から目的地へ向かって
                    「移動している」感を出す(2026-08-31新設)。 */}
                <circle className="cocode-phone-traveler" r="3.5">
                  <animateMotion dur="3.6s" repeatCount="indefinite" rotate="auto">
                    <mpath href="#cocode-route-path" />
                  </animateMotion>
                </circle>
              </svg>
              <span className="cocode-phone-pin cocode-phone-pin-start">📍</span>
              <span className="cocode-phone-pin cocode-phone-pin-end">🚩</span>
            </div>
          </div>
          <span className="cocode-phone-deco cocode-phone-deco-2">🌳</span>
        </div>

        <div className="cocode-landing-features">
          {FEATURES.map((f) => (
            <div key={f.label} className="cocode-landing-feature">
              <span className={`cocode-landing-feature-icon cocode-tone-${f.tone}`} aria-hidden>
                {f.icon}
              </span>
              <span className="cocode-landing-feature-label">{f.label}</span>
            </div>
          ))}
        </div>

        <div className="cocode-landing-cta-group">
          <button className="cocode-btn cocode-btn-primary cocode-landing-cta" onClick={onStart}>
            共有を開始する
          </button>
          <button className="cocode-btn cocode-btn-secondary" onClick={() => setModal("how")}>
            使い方を見る
          </button>
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

      {modal && (
        <div className="cocode-modal-backdrop" onClick={() => setModal(null)}>
          <div className="cocode-glass cocode-modal cocode-modal-scroll" onClick={(e) => e.stopPropagation()}>
            {modal === "about" && (
              <>
                <p className="cocode-modal-title">サービスについて</p>
                <p className="cocode-modal-body">
                  cocodeは、待ち合わせや外出時に、大切な人と今いる場所をリアルタイムに共有できるWebアプリです。友人との待ち合わせはもちろん、お子さんの下校時の見守りや、旅行先でのグループ行動など、様々な場面でご利用いただけます。
                </p>
                <p className="cocode-modal-body">
                  アカウント登録は一切不要です。目的地を決めて共有リンクを発行するだけで、友達はそのリンクを開くだけですぐに参加できます。共有は1時間で自動的に終了するため、使い終わった後の管理も必要ありません。
                </p>
              </>
            )}
            {modal === "how" && (
              <>
                <p className="cocode-modal-title">使い方</p>
                <ol className="cocode-landing-steps-list cocode-modal-steps">
                  {STEPS.map((s, i) => (
                    <li key={s}>
                      <span className="cocode-landing-step-num">{i + 1}</span>
                      {s}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {modal === "privacy" && (
              <>
                <p className="cocode-modal-title">プライバシーと安全性</p>
                <p className="cocode-modal-body">
                  共有リンクは、推測が困難なランダムな文字列(セッショントークン)で保護されています。このリンクを知っている人だけが、そのセッションに参加し、参加者の位置情報を見ることができます。
                </p>
                <p className="cocode-modal-body">
                  位置情報は共有中のみサーバー上で保持され、共有が終了(手動終了、または1時間の期限切れ)すると削除されます。アカウント登録を行わないため、個人を特定できる情報を継続的に保持することもありません。
                </p>
                <p className="cocode-modal-body">
                  より詳しい内容は、メニューの「プライバシーポリシー」をご覧ください。
                </p>
              </>
            )}
            {modal === "security" && (
              <>
                <p className="cocode-modal-title">安心のセキュリティ</p>
                <p className="cocode-modal-body">
                  cocodeとブラウザ間、およびサーバー間の通信は、すべてHTTPS/WSSにより暗号化されています。
                </p>
                <p className="cocode-modal-body">
                  セッションへのアクセスは、推測困難なトークンを持つ端末のみに制限されており、第三者が総当たりでセッションに侵入することは実質的に困難です。
                </p>
                <p className="cocode-modal-body">
                  ただし、共有リンク自体を第三者に転送すると、その相手も参加者の位置情報を閲覧できてしまいます。信頼できる相手にのみ共有リンクを送付するようにしてください。
                </p>
              </>
            )}
            {modal === "ads" && (
              <>
                <p className="cocode-modal-title">広告について</p>
                <p className="cocode-modal-body">
                  cocodeは無料でご利用いただけるサービスです。サーバー運用等の費用の一部として、トップページにGoogle AdSenseによる広告を表示しています。
                </p>
                <p className="cocode-modal-body">
                  表示される広告はコンテンツと明確に区別される位置に配置しており、地図・位置情報共有の画面には広告を表示しません。
                </p>
              </>
            )}
            <button className="cocode-btn cocode-btn-secondary" onClick={() => setModal(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
