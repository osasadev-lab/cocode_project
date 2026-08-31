"use client";

import { useState } from "react";
import { AdSlot } from "./AdSlot";
import { FeedbackModal } from "./FeedbackModal";

interface GuestLeftScreenProps {
  onBackToTop: () => void;
}

// ゲストが「退出する」を確定した際に到達する画面(2026-08-31新設)。
// 他の参加者の共有はそのまま継続されるため、ホストのSessionEndedScreenとは
// 別に用意する。フィードバックはここ(退出直後)から送れるようにする
// (仕様書§17.1、2026-08-31改訂: 汎用メニューからではなく、体験の直後の
// このタイミングで案内する)。
export function GuestLeftScreen({ onBackToTop }: GuestLeftScreenProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <div className="cocode-center-shell">
      <div className="cocode-glass cocode-modal">
        <div className="cocode-modal-icon">🚪</div>
        <p className="cocode-modal-title">退出しました</p>
        <p className="cocode-modal-body">位置共有から退出しました。他の参加者の共有はそのまま継続されています。</p>
        <button className="cocode-btn cocode-btn-primary" onClick={onBackToTop}>
          トップ画面に戻る
        </button>
        <button className="cocode-btn cocode-btn-secondary" onClick={() => setFeedbackOpen(true)}>
          💬 フィードバックを送る
        </button>
        <AdSlot />
      </div>

      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}
