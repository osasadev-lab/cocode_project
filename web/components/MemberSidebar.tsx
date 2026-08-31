"use client";

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

const TRANSPORT_ICON: Record<string, string> = { walk: "🚶", car: "🚗", train: "🚃" };

// メンバー表示ボタン押下で開く右サイドバー。参加中のメンバーの表示アイコン
// (§6.1で確定した19種、実画像)・表示名・移動手段・所要時間を一覧表示する。
// 1対多対応済みのsync/participant_joinedデータをそのまま使うため、
// 地図上に描画されるのが自分+1名のみの現段階(Phase 5の暫定実装)でも、
// このリストは実際の全参加者を正しく表示できる。
//
// アクティビティログ(参加/退出/到着/ひとことメッセージ)はここには表示しない
// (2026-08-31改訂: フッターの「メンバー」はメンバー一覧に専念させ、ログは
// 別途「チャット」から開く左サイドバー(ChatSidebar.tsx)へ分離した)。
export function MemberSidebar({ open, onClose, participants, selfParticipantId, arrivedIds, onChangeTransport }: MemberSidebarProps) {
  if (!open) return null;

  return (
    <>
      <div className="cocode-sidebar-backdrop" onClick={onClose} />
      <nav className="cocode-sidebar cocode-sidebar-right" aria-label="参加者一覧">
        <div className="cocode-sidebar-header">
          <span className="cocode-brand" style={{ fontSize: 16 }}>
            参加者({participants.length}人)
          </span>
          <button className="cocode-sidebar-close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <div className="cocode-member-list">
          {participants.map((p) => {
            const isSelf = p.id === selfParticipantId;
            return (
              <div key={p.id} className="cocode-member-row">
                <div className="cocode-member-row-top">
                  <span className={`cocode-member-avatar ${isSelf ? "cocode-tone-a-solid" : "cocode-tone-b-solid"}`}>
                    <img src={avatarIconSrc(p.avatarIcon)} alt="" />
                  </span>
                  <span className="cocode-member-name">
                    {p.displayName}
                    {isSelf && <span className="cocode-member-self-tag">あなた</span>}
                    {arrivedIds.has(p.id) && <span className="cocode-member-arrived-tag" title="目的地に到着済み">🏁 到着</span>}
                  </span>
                  <span className={`cocode-status-dot ${p.live ? "cocode-status-dot-online" : "cocode-status-dot-offline"}`} />
                </div>
                <div className="cocode-member-row-bottom">
                  {/* 移動手段の変更は本人のみ可能(仕様書§7)。他参加者の行は表示のみ。 */}
                  {isSelf ? (
                    <button className="cocode-member-transport cocode-member-transport-btn" onClick={onChangeTransport} title="移動手段を変更">
                      {TRANSPORT_ICON[p.transportMode] ?? ""}
                      {p.etaSeconds != null && <span className="cocode-member-eta">{formatEta(p.etaSeconds)}</span>}
                      <span className="cocode-hint">変更</span>
                    </button>
                  ) : (
                    <span className="cocode-member-transport">
                      {TRANSPORT_ICON[p.transportMode] ?? ""}
                      {p.etaSeconds != null && <span className="cocode-member-eta">{formatEta(p.etaSeconds)}</span>}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </nav>
    </>
  );
}
