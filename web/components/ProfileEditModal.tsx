"use client";

import { useState } from "react";
import { Button, FieldError, Input, Label, Modal, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Monitor, Moon, Pencil, Sun } from "lucide-react";
import { AvatarPicker } from "./AvatarPicker";
import { loadThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";

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
const THEME_OPTIONS: { mode: ThemeMode; icon: typeof Sun; label: string }[] = [
  { mode: "system", icon: Monitor, label: "システム" },
  { mode: "light", icon: Sun, label: "ライト" },
  { mode: "dark", icon: Moon, label: "ダーク" },
];

export function ProfileEditModal({ currentDisplayName, currentAvatarIcon, onClose, onSave }: ProfileEditModalProps) {
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [avatarIcon, setAvatarIcon] = useState(currentAvatarIcon);
  const [validationError, setValidationError] = useState<string | null>(null);
  // themeMode(2026-09-02新設、仕様書§20.3): 表示名・アイコンと違い、選択した
  // 瞬間に即座に画面へ反映・保存する(下の「保存する」ボタンによる
  // profile_update送信とは無関係な、端末ローカルの見た目設定のため)。
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());

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

            <div className="flex flex-col gap-1.5 text-left">
              <Label>表示テーマ</Label>
              <ToggleButtonGroup
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[themeMode]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as ThemeMode | undefined;
                  if (!next) return;
                  setThemeMode(next);
                  saveThemeMode(next);
                }}
                isDetached
                fullWidth
                className="flex w-full min-w-0 gap-2.5"
              >
                {THEME_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <ToggleButton key={opt.mode} id={opt.mode} className="flex h-auto min-w-0 flex-1 flex-col items-center gap-1 py-2.5 md:h-auto">
                      <Icon className="size-4.5 shrink-0" aria-hidden />
                      <span className="truncate">{opt.label}</span>
                    </ToggleButton>
                  );
                })}
              </ToggleButtonGroup>
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
