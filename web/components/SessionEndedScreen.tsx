"use client";

interface SessionEndedScreenProps {
  reason: "manual" | "ttl";
}

/**
 * A's full-screen destination once the session ends (spec §5.5/§9) — a
 * dedicated screen rather than a modal over the map, since there's nothing
 * left to show on the map at that point.
 *
 * セッション終了後に A が到達する全画面表示（仕様書§5.5/§9）。
 * その時点で地図に表示すべきものが無いため、地図の上のモーダルではなく
 * 専用画面としている。
 */
export function SessionEndedScreen({ reason }: SessionEndedScreenProps) {
  const title = reason === "manual" ? "共有を終了しました" : "セッションの有効期限が切れました";
  const body =
    reason === "manual"
      ? "位置共有を終了しました。もう一度待ち合わせを共有するには、新しく共有リンクを発行してください。"
      : "このセッションは作成から30分で自動的に終了する設計です。待ち合わせが続く場合は、新しく共有リンクを発行してください。";

  return (
    <div className="cocode-center-shell">
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
