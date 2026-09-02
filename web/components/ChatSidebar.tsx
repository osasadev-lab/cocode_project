"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Input } from "@heroui/react";
import { Flag, Hand, HeartHandshake, PersonStanding, Send, ThumbsUp, Timer } from "lucide-react";
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

// PRESET_STAMPS: プリセットのひとことメッセージ(仕様書§12.1-④)。
// 2026-09-02改訂: 送信テキスト自体に含めていた絵文字を廃止し(絵文字廃止方針)、
// 見た目上のアイコンはボタン側(startContentのlucideアイコン)だけで表現する。
const PRESET_STAMPS: { text: string; icon: typeof Flag }[] = [
  { text: "到着しました", icon: Flag },
  { text: "少し遅れます", icon: Timer },
  { text: "急いでます", icon: PersonStanding },
  { text: "ありがとう", icon: HeartHandshake },
  { text: "了解です", icon: ThumbsUp },
];
const MAX_CUSTOM_LENGTH = 20;

// COOLDOWN_MS: サーバー側のExpressionCooldown(server/internal/hub/hub.go,
// 3秒)と揃えたクライアント側クールダウン(2026-09-02新設、p7残課題の対応)。
//
// 背景: onSendは送信直後に楽観的にactivityLogへ追加するが、サーバーは
// クールダウン中の送信を拒否するのみでACKを返さない。連打すると
// 「自分の画面には全部残るが、実際には一部しか他参加者へ届いていない」
// 不具合があったため、そもそも連打できないようボタン側で抑止する。
const COOLDOWN_MS = 3000;

// フッターの「チャット」ボタンで開く左サイドバー(2026-08-31新設)。
// これまで別々だったアクティビティログの閲覧(旧MemberSidebar)とスタンプ
// 送信(旧StampModal)を1つの画面に統合し、チャットのように下に最新の
// やり取りが並ぶ形にした(参加/退出/到着の通知と、ひとことメッセージ/
// スタンプが同じ時系列に混ざって表示される)。
//
// 2026-09-02改訂: HeroUIのDrawerへ置き換え。
export function ChatSidebar({ open, onClose, activityLog, onSend }: ChatSidebarProps) {
  const [customText, setCustomText] = useState("");
  const [coolingDown, setCoolingDown] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 古い→新しいの順(チャットの慣習通り、下が最新)。
  const orderedLog = [...activityLog].reverse();

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [open, activityLog]);

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
  }, []);

  function send(kind: "stamp" | "reaction", text?: string) {
    if (coolingDown) return;
    onSend(kind, text);
    setCustomText("");
    setCoolingDown(true);
    cooldownTimer.current = setTimeout(() => setCoolingDown(false), COOLDOWN_MS);
  }

  function sendCustom() {
    const trimmed = customText.trim();
    if (trimmed === "") return;
    send("stamp", trimmed);
  }

  return (
    <Drawer isOpen={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Backdrop>
        <Drawer.Content placement="left">
          <Drawer.Dialog aria-label="チャット" className="flex w-80 max-w-[86vw] flex-col gap-3 p-4">
            <Drawer.Header className="flex items-center gap-2">
              <Drawer.Heading className="text-base font-bold">チャット</Drawer.Heading>
              <Drawer.CloseTrigger className="ml-auto" />
            </Drawer.Header>

            <Drawer.Body ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {orderedLog.length === 0 ? (
                <p className="text-xs text-muted">まだやり取りはありません</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {orderedLog.map((entry) => {
                    const Icon = ACTIVITY_ICON[entry.kind];
                    return (
                      <div key={entry.id} className="flex items-baseline gap-2 px-1 py-1.5 text-xs">
                        <Icon size={13} className="shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1 text-muted [overflow-wrap:break-word]">{activityText(entry)}</span>
                        <span className="shrink-0 text-[11px] text-muted">{formatActivityTime(entry.at)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Drawer.Body>

            <div className="flex shrink-0 flex-col gap-2.5 border-t border-border pt-3">
              <Button variant="outline" onPress={() => send("reaction")} isDisabled={coolingDown} className="gap-2">
                <Hand size={16} aria-hidden />
                手を振る
              </Button>

              <div className="flex flex-wrap justify-center gap-2">
                {PRESET_STAMPS.map(({ text, icon: Icon }) => (
                  <Button key={text} variant="outline" size="sm" onPress={() => send("stamp", text)} isDisabled={coolingDown} className="gap-1.5">
                    <Icon size={13} aria-hidden />
                    {text}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value.slice(0, MAX_CUSTOM_LENGTH))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendCustom();
                  }}
                  placeholder="ひとこと入力…"
                  className="min-w-0 flex-1"
                />
                <Button isIconOnly onPress={sendCustom} isDisabled={customText.trim() === "" || coolingDown} aria-label="送信">
                  <Send size={16} aria-hidden />
                </Button>
              </div>
            </div>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
