"use client";

import { useState } from "react";
import { AvatarPicker } from "./AvatarPicker";

interface ProfileEditModalProps {
  currentDisplayName: string;
  currentAvatarIcon: string;
  onClose: () => void;
  onSave: (displayName: string, avatarIcon: string) => void;
}

// 共有中のプロフィール編集モーダル(仕様書§14.5、2026-08-31実装)。ホスト・
// ゲスト共通、表示名・アイコンの初回入力時と同じUI(AvatarPicker)を再利用する。
// 移動手段はこの画面では扱わない(既存の「移動手段」ボタンと役割が重複するため)。
// サーバー側のクールダウン(1参加者あたり5秒に1回まで)超過時のエラーは、
// LiveSession側でsocket.errorMessageをトーストとして表示する(この画面自体は
// 楽観的に即座に閉じる)。
export function ProfileEditModal({ currentDisplayName, currentAvatarIcon, onClose, onSave }: ProfileEditModalProps) {
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [avatarIcon, setAvatarIcon] = useState(currentAvatarIcon);
  const [validationError, setValidationError] = useState<string | null>(null);

  function save() {
    if (displayName.trim() === "") {
      setValidationError("表示名を入力してください");
      return;
    }
    onSave(displayName.trim(), avatarIcon);
  }

  return (
    <div className="cocode-modal-backdrop" onClick={onClose}>
      <div className="cocode-glass cocode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cocode-modal-icon">✏️</div>
        <p className="cocode-modal-title">プロフィールを編集</p>

        <label className="cocode-hint" htmlFor="cocode-profile-display-name">
          表示名(20文字以内)
        </label>
        <input
          id="cocode-profile-display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
          placeholder="例: たろう"
          className="cocode-text-input"
        />
        <label className="cocode-hint">アイコン</label>
        <AvatarPicker value={avatarIcon} onChange={setAvatarIcon} />

        {validationError && <p className="cocode-error">{validationError}</p>}

        <button className="cocode-btn cocode-btn-primary" onClick={save}>
          保存する
        </button>
        <button className="cocode-btn cocode-btn-secondary" onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
