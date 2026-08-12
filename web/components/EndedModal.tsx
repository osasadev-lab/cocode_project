"use client";

interface EndedModalProps {
  reason: "manual" | "ttl";
}

/** Shown on session_ended/session_expired (spec §5.5/§9): always tells the
 * user what happened and what to do next, since the TTL never extends. */
export function EndedModal({ reason }: EndedModalProps) {
  const title = reason === "manual" ? "共有が終了しました" : "セッションの有効期限が切れました";
  const body =
    reason === "manual"
      ? "どちらかが共有を終了しました。もう一度待ち合わせを共有するには、新しく共有リンクを発行してください。"
      : "このセッションは作成から30分で自動的に終了する設計です。待ち合わせが続く場合は、新しく共有リンクを発行してください。";

  return (
    <div className="cocode-modal-backdrop">
      <div className="cocode-glass cocode-modal">
        <div className="cocode-modal-icon">{reason === "manual" ? "👋" : "⏰"}</div>
        <p className="cocode-modal-title">{title}</p>
        <p className="cocode-modal-body">{body}</p>
        <button className="cocode-btn cocode-btn-primary" onClick={() => window.location.assign("/")}>
          新しく共有リンクを作成する
        </button>
      </div>
    </div>
  );
}
