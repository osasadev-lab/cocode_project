import type { MetadataRoute } from "next";

// PWA化(仕様書§18.1)。output: "export"での静的ビルド時、Route Handlerとして
// manifest.webmanifestに書き出される(next.config.jsのoutput: "export"と
// 両立することをNext.js公式ドキュメントで確認済み、§18.4)。
// Next.js 16はforce-staticの明示指定が無いと"output: export"でのビルドを
// 拒否するため(このRoute Handlerはリクエスト時APIに依存しない完全な
// 静的コンテンツのため、force-staticで問題ない)。
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "cocode - 待ち合わせ位置共有",
    short_name: "cocode",
    description: "認証不要、共有リンクだけでお互いの現在地と待ち合わせ場所をリアルタイムに共有できるアプリ",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f6fb",
    theme_color: "#f4f6fb",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
