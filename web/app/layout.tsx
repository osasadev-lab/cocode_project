// アプリ全体のルートレイアウト。ページ共通のメタ情報・グローバル CSS を定義する。
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { ADSENSE_CLIENT_ID } from "@/lib/config";

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
    <html lang="ja">
      <body>
        {children}
        <ServiceWorkerRegister />
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
