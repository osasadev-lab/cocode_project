import type { Metadata, Viewport } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "cocode | 待ち合わせ位置共有",
  description: "認証不要、共有リンクだけでお互いの現在地と待ち合わせ場所をリアルタイムに共有できるアプリ",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f19" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
