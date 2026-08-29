"use client";

interface StatusCardProps {
  peerLabel: string;
  online: boolean;
  lastUpdatedAt?: string;
}

// formatRelative は最終更新時刻（ISO文字列）を「◯分前に更新」のような
// 相対時間表示に変換する。
function formatRelative(iso?: string): string {
  if (!iso) return "まだ位置情報がありません";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return "たった今更新";
  if (seconds < 60) return `${seconds}秒前に更新`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分前に更新`;
}

/** 相手のオンライン状態・最終更新時刻を表示するカード（仕様書§9）。 */
export function StatusCard({ peerLabel, online, lastUpdatedAt }: StatusCardProps) {
  return (
    <div className="cocode-glass cocode-status-card">
      <div className="cocode-status-row">
        <span className={`cocode-status-dot ${online ? "cocode-status-dot-online" : "cocode-status-dot-offline"}`} />
        <strong>{peerLabel}</strong>
        <span style={{ color: "var(--fg-muted)" }}>{online ? "オンライン" : "オフライン"}</span>
      </div>
      <div className="cocode-status-row" style={{ color: "var(--fg-muted)" }}>
        {formatRelative(lastUpdatedAt)}
      </div>
    </div>
  );
}
