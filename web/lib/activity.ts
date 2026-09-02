import { DoorOpen, Flag, LogOut, MessageCircle, type LucideIcon } from "lucide-react";
import type { ActivityEntry } from "./types";

// アクティビティログ(参加/退出/到着/ひとことメッセージ)の表示用ヘルパー。
// MemberSidebar(旧仕様、現在は不使用)とChatSidebar(2026-08-31新設)で
// 共通の見た目にするため切り出した。2026-09-02改訂: 絵文字グリフから
// lucide-reactのアイコンコンポーネントへ変更(UI刷新、絵文字廃止)。
export const ACTIVITY_ICON: Record<ActivityEntry["kind"], LucideIcon> = {
  joined: DoorOpen,
  left: LogOut,
  arrived: Flag,
  message: MessageCircle,
};

export function activityText(entry: ActivityEntry): string {
  switch (entry.kind) {
    case "joined":
      return `${entry.displayName}さんが参加しました`;
    case "left":
      return `${entry.displayName}さんが退出しました`;
    case "arrived":
      return `${entry.displayName}さんが目的地に到着しました`;
    case "message":
      return `${entry.displayName}さん: ${entry.text ?? ""}`;
  }
}

export function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
