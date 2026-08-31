"use client";

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

const OPTIONS: { mode: TransportMode; icon: string; label: string }[] = [
  { mode: "walk", icon: "🚶", label: "徒歩" },
  { mode: "car", icon: "🚗", label: "車" },
  { mode: "train", icon: "🚃", label: "電車" },
];

// 表示名・アイコン入力と合わせて移動手段も選んでもらうための共通ピッカー
// (ホスト用CreateForm・ゲスト用LandingGuestで共用、2026-08-31新設)。
// 選択結果はセッション作成/参加直後、WebSocket接続確立時に
// transport_updateとして送信される(LiveSession側で処理)。
export function TransportPicker({ value, onChange, etaByMode }: TransportPickerProps) {
  return (
    <div className="cocode-transport-options">
      {OPTIONS.map((opt) => {
        const eta = etaByMode?.[opt.mode];
        return (
          <button
            key={opt.mode}
            type="button"
            className={`cocode-transport-option${opt.mode === value ? " cocode-transport-option-active" : ""}`}
            onClick={() => onChange(opt.mode)}
          >
            <span className="cocode-transport-option-icon" aria-hidden>
              {opt.icon}
            </span>
            <span>{opt.label}</span>
            {eta != null && <span className="cocode-transport-option-eta">{formatEta(eta)}</span>}
          </button>
        );
      })}
    </div>
  );
}
