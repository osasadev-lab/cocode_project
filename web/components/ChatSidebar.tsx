"use client";

import { useEffect, useRef, useState } from "react";
import { ACTIVITY_ICON, activityText, formatActivityTime } from "@/lib/activity";
import type { ActivityEntry } from "@/lib/types";

interface ChatSidebarProps {
  open: boolean;
  onClose: () => void;
  /** 新しい順(先頭が最新)で保持されているログ(useCocodeSocket.ts参照)。
   * チャット表示は逆順(古い→新しい、一番下が最新)にして描画する。 */
  activityLog: ActivityEntry[];
  /** kind="reaction"の場合textは常に空(サーバー側でも捨てられる、仕様書§12.1-⑤)。 */
  onSend: (kind: "stamp" | "reaction", text?: string) => void;
}

const PRESET_STAMPS = ["到着しました🏁", "少し遅れます⏰", "急いでます🏃", "ありがとう🙏", "了解です👌"];
const MAX_CUSTOM_LENGTH = 20;

// フッターの「チャット」ボタンで開く左サイドバー(2026-08-31新設)。
// これまで別々だったアクティビティログの閲覧(旧MemberSidebar)とスタンプ
// 送信(旧StampModal)を1つの画面に統合し、チャットのように下に最新の
// やり取りが並ぶ形にした(参加/退出/到着の通知と、ひとことメッセージ/
// スタンプが同じ時系列に混ざって表示される)。
export function ChatSidebar({ open, onClose, activityLog, onSend }: ChatSidebarProps) {
  const [customText, setCustomText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // 古い→新しいの順(チャットの慣習通り、下が最新)。
  const orderedLog = [...activityLog].reverse();

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [open, activityLog]);

  if (!open) return null;

  function send(kind: "stamp" | "reaction", text?: string) {
    onSend(kind, text);
    setCustomText("");
  }

  function sendCustom() {
    const trimmed = customText.trim();
    if (trimmed === "") return;
    send("stamp", trimmed);
  }

  return (
    <>
      <div className="cocode-sidebar-backdrop" onClick={onClose} />
      <nav className="cocode-sidebar" aria-label="チャット">
        <div className="cocode-sidebar-header">
          <span className="cocode-brand" style={{ fontSize: 16 }}>
            チャット
          </span>
          <button className="cocode-sidebar-close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <div className="cocode-chat-list" ref={listRef}>
          {orderedLog.length === 0 ? (
            <p className="cocode-hint">まだやり取りはありません</p>
          ) : (
            <div className="cocode-activity-log">
              {orderedLog.map((entry) => (
                <div key={entry.id} className="cocode-activity-row">
                  <span className="cocode-activity-icon">{ACTIVITY_ICON[entry.kind]}</span>
                  <span className="cocode-activity-text">{activityText(entry)}</span>
                  <span className="cocode-activity-time">{formatActivityTime(entry.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="cocode-chat-compose">
          <button className="cocode-btn cocode-btn-secondary" onClick={() => send("reaction")}>
            👋 手を振る
          </button>

          <div className="cocode-stamp-presets">
            {PRESET_STAMPS.map((s) => (
              <button key={s} className="cocode-stamp-preset-btn" onClick={() => send("stamp", s)}>
                {s}
              </button>
            ))}
          </div>

          <div className="cocode-stamp-custom-row">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value.slice(0, MAX_CUSTOM_LENGTH))}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendCustom();
              }}
              placeholder="ひとこと入力…"
              className="cocode-text-input"
            />
            <button className="cocode-btn cocode-btn-primary" onClick={sendCustom} disabled={customText.trim() === ""}>
              送信
            </button>
          </div>
        </div>
      </nav>
    </>
  );
}
