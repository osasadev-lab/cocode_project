"use client";

import { AVATAR_ICONS } from "@/lib/avatars";

interface AvatarPickerProps {
  value: string;
  onChange: (id: string) => void;
}

// 表示アイコン選択UI(仕様書§6.1、2026-08-31改訂: テキストのドロップダウンから、
// 実際に使われるアイコン画像を横並びで表示し横スクロールで選ぶ形式に変更)。
// 2026-09-02: HeroUIのToggleButtonGroupへ一度置き換えたが、後半のアイコンに
// 実質到達できない(スクロールでは全アイコンを表示しきれない)との報告が
// あったため、素のbuttonによるこの実装へ差し戻した(このコンポーネントのみ
// HeroUI化の対象外とする)。
export function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  return (
    <div className="cocode-avatar-picker">
      {AVATAR_ICONS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`cocode-avatar-picker-item${a.id === value ? " cocode-avatar-picker-item-active" : ""}`}
          onClick={() => onChange(a.id)}
          title={a.label}
          aria-label={a.label}
        >
          <img src={a.src} alt="" />
        </button>
      ))}
    </div>
  );
}
