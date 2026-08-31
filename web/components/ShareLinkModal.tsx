"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface ShareLinkModalProps {
  shareUrl: string;
  onClose: () => void;
}

// リンク共有ボタン押下で開くモーダル(2026-08-31新設)。ホスト・ゲストいずれも
// 常時招待できるようにする(仕様書§14.4)。ゲストが共有する場合も、URLに
// 含まれるトークンは全ゲスト共通の招待トークンのため、そのまま再共有して問題ない。
// QRコード(仕様書§12.1-②)もここから表示できる — セッション作成直後の専用
// 案内画面は廃止し、このモーダル1つに集約した(2026-08-31改訂)。
export function ShareLinkModal({ shareUrl, onClose }: ShareLinkModalProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(shareUrl, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shareUrl]);

  async function copy() {
    window.alert("共有リンクを知っている人は誰でも参加者全員の位置情報を見ることができます。信頼できる相手にのみ送ってください。");
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard APIが使えない場合(非セキュアコンテキスト等)は、表示中のURLを手動選択してコピーしてもらう。
    }
  }

  return (
    <div className="cocode-modal-backdrop" onClick={onClose}>
      <div className="cocode-glass cocode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cocode-modal-icon">🔗</div>
        <p className="cocode-modal-title">友達を招待</p>
        <div className="cocode-share-url" title={shareUrl}>
          {shareUrl}
        </div>
        <button className="cocode-btn cocode-btn-primary" onClick={copy}>
          {copied ? "コピーしました ✓" : "リンクをコピー"}
        </button>
        <button className="cocode-btn cocode-btn-secondary" onClick={() => setShowQr((v) => !v)} disabled={!qrDataUrl}>
          {showQr ? "QRコードを隠す" : "📷 QRコードを表示"}
        </button>
        {showQr && qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="共有URLのQRコード"
            style={{ width: 180, height: 180, alignSelf: "center", borderRadius: 12, marginTop: 8 }}
          />
        )}
        <button className="cocode-btn cocode-btn-secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
