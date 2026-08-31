"use client";

import { useEffect } from "react";

// PWA用Service Workerの登録（仕様書§18.3）。開発環境では無効化し、
// 本番ビルドのみ有効にする（開発中のホットリロードと、cache-firstの
// Service Workerキャッシュが競合しないようにするため）。
//
// 注意(2026-08-30、実装時に確定): 当初process.env.NODE_ENVで判定していたが、
// Next.js 16 + Turbopackの`next dev`では、このビルド時定数がdev実行時にも
// "production"として畳み込まれ、ガード自体がコンパイル後のコードから
// 消えてしまう(この状態のService Workerがdevサーバーの応答をcache-firstで
// 覆い隠し、コード変更が一切反映されなくなる不具合を実機で確認した)。
// ビルド時定数への依存を避けるため、実行時のhostnameで判定する方式に変更した
// — ローカル開発(`npm run dev`)は常にlocalhost/127.0.0.1で行われ、本番
// (Cloud Run/Firebase Hosting)は実ドメインになるため、この判定は環境変数の
// 畳み込み挙動に依存せず確実に機能する。
function isLocalDevHost(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (isLocalDevHost()) return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 登録失敗時もアプリ自体は通常通り動作するため、サイレントに諦める。
    });
  }, []);

  return null;
}
