"use client";

import { useState } from "react";

interface ShareLinkCardProps {
  shareUrl: string;
}

/** A's share-link reminder, shown until B joins (spec §2/§5.1). */
export function ShareLinkCard({ shareUrl }: ShareLinkCardProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable (e.g. insecure context) — the user can
      // still select the printed URL by hand.
    }
  }

  return (
    <div className="cocode-glass cocode-share-box" style={{ maxWidth: 320 }}>
      <strong style={{ fontSize: 13 }}>ユーザーBを招待</strong>
      <div className="cocode-share-url">{shareUrl}</div>
      <button className="cocode-btn cocode-btn-secondary" onClick={copy}>
        {copied ? "コピーしました ✓" : "リンクをコピー"}
      </button>
    </div>
  );
}
