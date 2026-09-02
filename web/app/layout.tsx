// アプリ全体のルートレイアウト。ページ共通のメタ情報・グローバル CSS を定義する。
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Toast } from "@heroui/react";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { MapLibreErrorFilter } from "@/components/MapLibreErrorFilter";
import { ADSENSE_CLIENT_ID } from "@/lib/config";

// HeroUIのダークモードはOS設定(prefers-color-scheme)ではなく.dark
// クラス/data-theme属性で切り替わる。既定は引き続きOS設定への自動追従だが、
// フッターのプロフィール編集から手動でライト/ダークを固定することもできる
// (仕様書§20.3、2026-09-02新設。選択はlocalStorage["cocode:theme"]に保存、
// lib/theme.ts参照)。静的書き出し(output: "export")のためサーバー側で
// 事前判定できず、ハイドレーション前にこのスクリプトで即座にクラスを
// 反映してチラつき(FOUC)を防ぐ。「システム」選択時(=未保存時)のみ、OS設定の
// 変更にその場で追従する — 手動固定時にOS側の変更で上書きされないようにするため。
const THEME_INIT_SCRIPT = `(function(){try{
  var KEY = "cocode:theme";
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var currentMode = function () {
    var v = localStorage.getItem(KEY);
    return (v === "light" || v === "dark") ? v : "system";
  };
  var apply = function (mode) {
    var dark = mode === "dark" || (mode === "system" && mq.matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  };
  apply(currentMode());
  mq.addEventListener("change", function () {
    if (currentMode() === "system") apply("system");
  });
} catch (e) {}})();`;

export const metadata: Metadata = {
  title: "cocode | 待ち合わせ位置共有",
  description: "認証不要、共有リンクだけでお互いの現在地と待ち合わせ場所をリアルタイムに共有できるアプリ",
  icons: {
    icon: "/brand/icon-192.png",
    apple: "/brand/icon-192.png",
  },
  openGraph: {
    title: "cocode | 待ち合わせ位置共有",
    description: "認証不要、共有リンクだけでお互いの現在地と待ち合わせ場所をリアルタイムに共有できるアプリ",
    images: ["/brand/icon-512.png"],
  },
};

// ライト/ダークモードでステータスバーの色を切り替える。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f19" },
  ],
};

// RootLayout は全ページ共通の HTML 構造（<html>/<body>）を提供する。
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        {children}
        {/* 通知(目的地変更・エラー・参加者切断・スタンプ/リアクション等)は
            すべて画面上部に表示する(2026-09-02改訂、ユーザー要望)。 */}
        <Toast.Provider placement="top" />
        <ServiceWorkerRegister />
        <MapLibreErrorFilter />
        {/* AdSenseローダーはパブリッシャーID設定時のみ読み込む(未設定時は
            スクリプト自体を配信しない、仕様書§15.1)。 */}
        {ADSENSE_CLIENT_ID && (
          <Script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`}
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
