"use client";

import { useState } from "react";
import { AdSlot } from "./AdSlot";
import { FeedbackModal } from "./FeedbackModal";

interface SessionEndedScreenProps {
  reason: "manual" | "ttl";
}

/**
 * セッション終了後に A が到達する全画面表示（仕様書§5.5/§9）。
 * その時点で地図に表示すべきものが無いため、地図の上のモーダルではなく
 * 専用画面としている。ライブ位置共有画面ではないため、非リアルタイム画面
 * 向けの広告エリア(AdSlot)を置ける(仕様書§15、2026-08-31追加)。
 * フィードバックはここ(共有終了直後)から送れるようにする(仕様書§17.1、
 * 2026-08-31改訂: 汎用メニューからではなく、体験の直後のこのタイミングで案内する)。
 */
export function SessionEndedScreen({ reason }: SessionEndedScreenProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const title = reason === "manual" ? "共有を終了しました" : "セッションの有効期限が切れました";
  const body =
    reason === "manual"
      ? "位置共有を終了しました。もう一度待ち合わせを共有するには、新しく共有リンクを発行してください。"
      : "このセッションは作成から1時間で自動的に終了する設計です。待ち合わせが続く場合は、新しく共有リンクを発行してください。";

  return (
    <div className="cocode-center-shell">
      <div className="cocode-glass cocode-modal">
        <div className="cocode-modal-icon">{reason === "manual" ? "👋" : "⏰"}</div>
        <p className="cocode-modal-title">{title}</p>
        <p className="cocode-modal-body">{body}</p>
        <button className="cocode-btn cocode-btn-primary" onClick={() => window.location.assign("/")}>
          新しく共有リンクを作成する
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
