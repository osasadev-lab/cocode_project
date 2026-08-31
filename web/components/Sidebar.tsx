"use client";

import { BUY_ME_A_COFFEE_URL } from "@/lib/config";

export type SidebarModalKind = "about" | "how" | "privacy" | "security" | "ads";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onOpenModal: (kind: SidebarModalKind) => void;
}

// ホスト用トップページのハンバーガーメニューから開く左サイドバー(2026-08-31新設)。
// モーダル表示する項目(サービスについて/使い方/プライバシーと安全性/
// 安心のセキュリティ/広告について)と、別タブで開く独立ページ
// (よくある質問/プライバシーポリシー/利用規約)を1つのメニューにまとめる。
// フィードバックはここではなく、共有終了(SessionEndedScreen)・退出
// (GuestLeftScreen)の各画面に置く(2026-08-31改訂、体験の直後に案内するため)。
export function Sidebar({ open, onClose, onOpenModal }: SidebarProps) {
  if (!open) return null;

  return (
    <>
      <div className="cocode-sidebar-backdrop" onClick={onClose} />
      <nav className="cocode-sidebar" aria-label="メニュー">
        <div className="cocode-sidebar-header">
          <img src="/brand/logo.png" alt="" style={{ height: 24 }} />
          <span className="cocode-brand" style={{ fontSize: 16 }}>
            cocode
          </span>
          <button className="cocode-sidebar-close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <button className="cocode-sidebar-item" onClick={() => onOpenModal("about")}>
          <span className="cocode-sidebar-item-icon" aria-hidden>
            ℹ️
          </span>
          サービスについて
        </button>
        <button className="cocode-sidebar-item" onClick={() => onOpenModal("how")}>
          <span className="cocode-sidebar-item-icon" aria-hidden>
            📖
          </span>
          使い方
        </button>
        <button className="cocode-sidebar-item" onClick={() => onOpenModal("privacy")}>
          <span className="cocode-sidebar-item-icon" aria-hidden>
            🔒
          </span>
          プライバシーと安全性
        </button>
        <button className="cocode-sidebar-item" onClick={() => onOpenModal("security")}>
          <span className="cocode-sidebar-item-icon" aria-hidden>
            🛡️
          </span>
          安心のセキュリティ
        </button>

        <hr className="cocode-sidebar-divider" />

        <a className="cocode-sidebar-item" href="/faq" target="_blank" rel="noreferrer">
          <span className="cocode-sidebar-item-icon" aria-hidden>
            ❓
          </span>
          よくある質問
          <span className="cocode-sidebar-item-external" aria-hidden>
            ↗
          </span>
        </a>
        <a className="cocode-sidebar-item" href="/privacy" target="_blank" rel="noreferrer">
          <span className="cocode-sidebar-item-icon" aria-hidden>
            📄
          </span>
          プライバシーポリシー
          <span className="cocode-sidebar-item-external" aria-hidden>
            ↗
          </span>
        </a>
        <a className="cocode-sidebar-item" href="/terms" target="_blank" rel="noreferrer">
          <span className="cocode-sidebar-item-icon" aria-hidden>
            📋
          </span>
          利用規約
          <span className="cocode-sidebar-item-external" aria-hidden>
            ↗
          </span>
        </a>

        <hr className="cocode-sidebar-divider" />

        <button className="cocode-sidebar-item" onClick={() => onOpenModal("ads")}>
          <span className="cocode-sidebar-item-icon" aria-hidden>
            📢
          </span>
          広告について
        </button>
        {BUY_ME_A_COFFEE_URL && (
          <a className="cocode-sidebar-item" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
            <span className="cocode-sidebar-item-icon" aria-hidden>
              ☕
            </span>
            開発者を応援する
            <span className="cocode-sidebar-item-external" aria-hidden>
              ↗
            </span>
          </a>
        )}
      </nav>
    </>
  );
}
