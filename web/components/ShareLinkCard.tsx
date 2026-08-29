"use client";

import { useState } from "react";

interface ShareLinkCardProps {
  shareUrl: string;
}

/** B が参加するまで表示され続ける、A 向けの共有リンク表示カード（仕様書§2/§5.1）。 */
export function ShareLinkCard({ shareUrl }: ShareLinkCardProps) {
  const [copied, setCopied] = useState(false);

  // copy: 注意喚起のアラートを出した上で、共有リンクをクリップボードへコピーする。
  async function copy() {
    window.alert("共有リンクを知っている人は誰でもお互いの位置情報を見ることができます。信頼できる相手にのみ送ってください。");
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API が使えない場合（非セキュアコンテキスト等）。
      // 表示されているURLを手動で選択してコピーしてもらう。
    }
  }

  return (
    <div className="cocode-glass cocode-share-box" style={{ maxWidth: 320 }}>
      <strong style={{ fontSize: 13 }}>友達を招待</strong>
      <div className="cocode-share-url" title={shareUrl}>{shareUrl}</div>
      <button className="cocode-btn cocode-btn-secondary" onClick={copy}>
        {copied ? "コピーしました ✓" : "リンクをコピー"}
      </button>
    </div>
  );
}
