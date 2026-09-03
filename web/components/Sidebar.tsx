"use client";

import { Drawer, ListBox } from "@heroui/react";
import { BookOpen, ExternalLink, FileText, HelpCircle, Info, ClipboardList, Lock, ShieldCheck } from "lucide-react";

export type SidebarModalKind = "about" | "how" | "privacy" | "security";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onOpenModal: (kind: SidebarModalKind) => void;
}

// ホスト用トップページのハンバーガーメニューから開く左サイドバー(2026-08-31新設)。
// モーダル表示する項目(サービスについて/使い方/プライバシーと安全性/
// 安心のセキュリティ)と、別タブで開く独立ページ
// (よくある質問/プライバシーポリシー/利用規約)を1つのメニューにまとめる。
// フィードバックはここではなく、共有終了(SessionEndedScreen)・退出
// (GuestLeftScreen)の各画面に置く(2026-08-31改訂、体験の直後に案内するため)。
//
// 2026-09-02改訂: HeroUIのDrawer/ListBoxへ置き換え。
export function Sidebar({ open, onClose, onOpenModal }: SidebarProps) {
  return (
    <Drawer isOpen={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Backdrop>
        <Drawer.Content placement="left">
          <Drawer.Dialog aria-label="メニュー" className="flex w-75 max-w-[84vw] flex-col gap-1 p-3.5">
            <Drawer.Header className="flex items-center gap-2.5 px-2.5 pb-3">
              <img src="/brand/logo.png" alt="" className="h-6 w-auto" />
              <Drawer.Heading className="text-base font-bold">cocode</Drawer.Heading>
              <Drawer.CloseTrigger className="ml-auto" />
            </Drawer.Header>

            <ListBox aria-label="メニュー項目" selectionMode="none" className="flex flex-col gap-1 border-none p-0">
              <ListBox.Item id="about" onAction={() => onOpenModal("about")} className="gap-3">
                <Info size={18} aria-hidden />
                サービスについて
              </ListBox.Item>
              <ListBox.Item id="how" onAction={() => onOpenModal("how")} className="gap-3">
                <BookOpen size={18} aria-hidden />
                使い方
              </ListBox.Item>
              <ListBox.Item id="privacy" onAction={() => onOpenModal("privacy")} className="gap-3">
                <Lock size={18} aria-hidden />
                プライバシーと安全性
              </ListBox.Item>
              <ListBox.Item id="security" onAction={() => onOpenModal("security")} className="gap-3">
                <ShieldCheck size={18} aria-hidden />
                安心のセキュリティ
              </ListBox.Item>
            </ListBox>

            <hr className="my-2 border-border" />

            <ListBox aria-label="関連ページ" selectionMode="none" className="flex flex-col gap-1 border-none p-0">
              <ListBox.Item href="/faq" target="_blank" rel="noreferrer" className="gap-3">
                <HelpCircle size={18} aria-hidden />
                よくある質問
                <ExternalLink size={13} className="ml-auto text-muted" aria-hidden />
              </ListBox.Item>
              <ListBox.Item href="/privacy" target="_blank" rel="noreferrer" className="gap-3">
                <FileText size={18} aria-hidden />
                プライバシーポリシー
                <ExternalLink size={13} className="ml-auto text-muted" aria-hidden />
              </ListBox.Item>
              <ListBox.Item href="/terms" target="_blank" rel="noreferrer" className="gap-3">
                <ClipboardList size={18} aria-hidden />
                利用規約
                <ExternalLink size={13} className="ml-auto text-muted" aria-hidden />
              </ListBox.Item>
            </ListBox>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
