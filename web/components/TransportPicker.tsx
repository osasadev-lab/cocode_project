"use client";

import { Car, Footprints } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { formatEta } from "@/lib/eta";
import type { TransportEtaMap } from "@/lib/useTransportEtaOptions";
import type { TransportMode } from "@/lib/types";

interface TransportPickerProps {
  value: TransportMode;
  onChange: (mode: TransportMode) => void;
  /** モードごとの目安所要時間(2026-08-31新設)。指定時、各ボタンの下に
   * 「約12分」のように表示する。ホスト作成時・ゲスト参加時・フッターからの
   * 変更(TransportModal)いずれも共通のこの見た目で表示する。未指定/
   * 該当モードの値が無い場合はラベルのみ表示する(現在地・目的地が
   * 未確定な場合など)。 */
  etaByMode?: TransportEtaMap;
}

// 電車は2026-09-03、ボタンを非表示に変更(ユーザー指示)。NAVITIME単独運用
// (ジョルダン不採用確定、§7.1.2)で無料枠が月500回のみとなり電車ETAが
// 単一障害点になったための一時的な措置。バックエンド・型定義側の
// transportMode="train"自体は残しており、選択肢を出さないだけの変更。
const OPTIONS: { mode: TransportMode; icon: typeof Footprints; label: string }[] = [
  { mode: "walk", icon: Footprints, label: "徒歩" },
  { mode: "car", icon: Car, label: "車" },
];

// 表示名・アイコン入力と合わせて移動手段も選んでもらうための共通ピッカー
// (ホスト用CreateForm・ゲスト用LandingGuestで共用、2026-08-31新設)。
// 選択結果はセッション作成/参加直後、WebSocket接続確立時に
// transport_updateとして送信される(LiveSession側で処理)。
// 2026-09-02改訂: HeroUIのToggleButtonGroup(単一選択)へ置き換え。
export function TransportPicker({ value, onChange, etaByMode }: TransportPickerProps) {
  return (
    <ToggleButtonGroup
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next) onChange(next as TransportMode);
      }}
      isDetached
      fullWidth
      className="flex w-full min-w-0 gap-2.5"
    >
      {OPTIONS.map((opt) => {
        const eta = etaByMode?.[opt.mode];
        const Icon = opt.icon;
        return (
          // min-w-0: flexアイテムの既定min-width:autoのままだと、ETA文言
          // (例:「約12分」)を含む中身の自然幅が優先されflex-1が縮められず、
          // 3つ並べたときにカード幅からはみ出していた(2026-09-02修正)。
          // h-auto md:h-auto: HeroUIのToggleButtonの既定スタイル(.toggle-button
          // 基底クラス)がh-10 md:h-9という固定高さを持っており、アイコン+
          // ラベル+ETAの3段構成だとその高さに収まらず、ラベル・ETAの文字列が
          // 常に見えなくなっていた(2026-09-02修正、不具合報告により発覚)。
          <ToggleButton
            key={opt.mode}
            id={opt.mode}
            className="flex h-auto min-w-0 flex-1 flex-col items-center gap-1 py-3.5 md:h-auto"
          >
            <Icon className="size-5.5 shrink-0" aria-hidden />
            <span className="truncate">{opt.label}</span>
            {eta != null && <span className="w-full truncate text-center text-xs text-muted">{formatEta(eta)}</span>}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}
