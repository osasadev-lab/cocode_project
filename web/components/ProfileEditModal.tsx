"use client";

import { useState } from "react";
import { Button, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { Pencil } from "lucide-react";
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
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog className="flex flex-col gap-3.5 p-7 text-center">
            <Modal.Icon>
              <Pencil />
            </Modal.Icon>
            <Modal.Heading className="text-lg font-bold">プロフィールを編集</Modal.Heading>

            <TextField
              value={displayName}
              onChange={(v) => setDisplayName(v.slice(0, 20))}
              isInvalid={!!validationError}
              className="flex flex-col gap-1.5 text-left"
            >
              <Label>表示名(20文字以内)</Label>
              <Input placeholder="例: たろう" />
              {validationError && <FieldError>{validationError}</FieldError>}
            </TextField>

            <div className="flex flex-col gap-1.5 text-left">
              <Label>アイコン</Label>
              <AvatarPicker value={avatarIcon} onChange={setAvatarIcon} />
            </div>

            <Button variant="primary" fullWidth onPress={save}>
              保存する
            </Button>
            <Button variant="outline" fullWidth onPress={onClose}>
              キャンセル
            </Button>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
