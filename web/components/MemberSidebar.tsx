"use client";

import { Avatar, Button, Chip, Drawer } from "@heroui/react";
import { Car, Flag, Footprints, LocateOff, TrainFront, type LucideIcon } from "lucide-react";
import type { ParticipantPublic } from "@/lib/types";
import { avatarIconSrc } from "@/lib/avatars";
import { formatEta } from "@/lib/eta";

interface MemberSidebarProps {
  open: boolean;
  onClose: () => void;
  participants: ParticipantPublic[];
  selfParticipantId: string | null;
  arrivedIds: Set<string>;
  onChangeTransport: () => void;
}

const TRANSPORT_ICON: Record<string, LucideIcon> = { walk: Footprints, car: Car, train: TrainFront };

// メンバー表示ボタン押下で開く右サイドバー。参加中のメンバーの表示アイコン
// (§6.1で確定した19種、実画像)・表示名・移動手段・所要時間を一覧表示する。
// 1対多対応済みのsync/participant_joinedデータをそのまま使うため、
// 地図上に描画されるのが自分+1名のみの現段階(Phase 5の暫定実装)でも、
// このリストは実際の全参加者を正しく表示できる。
//
// アクティビティログ(参加/退出/到着/ひとことメッセージ)はここには表示しない
// (2026-08-31改訂: フッターの「メンバー」はメンバー一覧に専念させ、ログは
// 別途「チャット」から開く左サイドバー(ChatSidebar.tsx)へ分離した)。
//
// 2026-09-02改訂: HeroUIのDrawerへ置き換え、位置情報オフモード(新設)の
// バッジを追加(自分・他参加者どちらの行にも表示する)。
export function MemberSidebar({ open, onClose, participants, selfParticipantId, arrivedIds, onChangeTransport }: MemberSidebarProps) {
  return (
    <Drawer isOpen={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label="参加者一覧" className="flex w-80 max-w-[86vw] flex-col gap-1 p-4">
            <Drawer.Header className="flex items-center gap-2 pb-2">
              <Drawer.Heading className="text-base font-bold">参加者({participants.length}人)</Drawer.Heading>
              <Drawer.CloseTrigger className="ml-auto" />
            </Drawer.Header>

            <Drawer.Body className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {participants.map((p) => {
                const isSelf = p.id === selfParticipantId;
                const TransportIcon = TRANSPORT_ICON[p.transportMode];
                return (
                  <div key={p.id} className="flex flex-col gap-1.5 rounded-(--radius-field) border-b border-border p-2.5 last:border-b-0">
                    <div className="flex items-center gap-2.5">
                      <Avatar color={isSelf ? "accent" : "default"} className="size-9 shrink-0">
                        <Avatar.Image src={avatarIconSrc(p.avatarIcon)} alt="" className="object-contain [image-rendering:pixelated]" />
                      </Avatar>
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
                        <span className="truncate">{p.displayName}</span>
                        {isSelf && <span className="text-xs text-muted">あなた</span>}
                        {p.locationSharing === false && (
                          <Chip color="default" size="sm" className="gap-1">
                            <LocateOff size={11} aria-hidden />
                            <Chip.Label>オフ</Chip.Label>
                          </Chip>
                        )}
                        {arrivedIds.has(p.id) && (
                          <Chip color="success" size="sm" title="目的地に到着済み" className="gap-1">
                            <Flag size={11} aria-hidden />
                            <Chip.Label>到着</Chip.Label>
                          </Chip>
                        )}
                      </span>
                      <span
                        className={`size-2 shrink-0 rounded-full ${p.live ? "bg-success shadow-[0_0_0_3px_var(--color-success-soft)]" : "bg-muted"}`}
                        aria-hidden
                      />
                    </div>
                    <div className="pl-11.5">
                      {/* 移動手段の変更は本人のみ可能(仕様書§7)。他参加者の行は表示のみ。 */}
                      {isSelf ? (
                        <Button variant="ghost" size="sm" onPress={onChangeTransport} className="h-auto gap-1.5 px-2 py-1 text-xs">
                          <TransportIcon size={15} aria-hidden />
                          {p.etaSeconds != null && <span className="text-muted">{formatEta(p.etaSeconds)}</span>}
                          <span>変更</span>
                        </Button>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sm text-foreground">
                          <TransportIcon size={15} aria-hidden />
                          {p.etaSeconds != null && <span className="text-xs text-muted">{formatEta(p.etaSeconds)}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
