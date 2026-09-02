"use client";

import { useState, type ReactNode } from "react";
import { ChevronUp, LocateFixed, Map as MapIcon, Search } from "lucide-react";
import { Button, Card, Input, Label } from "@heroui/react";
import type { DestinationPicker } from "@/lib/useDestinationPicker";

interface DestinationPickerPanelProps {
  picker: DestinationPicker;
  /** choose画面(方法選択)の見出し文。省略時は表示しない。 */
  title?: ReactNode;
  /** confirm(確定)ボタンの文言。 */
  confirmLabel: string;
  confirming?: boolean;
  onConfirm: () => void;
  /** 指定時、choose画面にも「キャンセル」ボタンを表示し、ピッカー全体を閉じる
   * (目的地変更で使用。新規作成時は指定不要 — 途中で戻る先が無いため)。 */
  onCancelAll?: () => void;
  /** picking画面(地点確定前)で、確定ボタンの直前に追加のフィールドを挿入する
   * (新規作成時の表示名・アイコン・移動手段入力など)。 */
  children?: ReactNode;
  /** picking画面のオーバーレイに追加するクラス名。
   * LiveSession(ライブマップ)ではヘッダーバー(§14.9)の下にずらすために使う。 */
  overlayClassName?: string;
}

// DestinationPickerPanel: 目的地の新規設定(CreateForm)・変更(LiveSession)で
// 共通のUIフロー(2026-08-31新設)。「現在地を使う/地図から選択する/住所で検索する」
// のいずれの方式でも、最終的に同じpicking画面(地図タップで微調整・確定)へ
// 合流させることで、新規設定・変更の体験を統一する。
export function DestinationPickerPanel({
  picker,
  title,
  confirmLabel,
  confirming,
  onConfirm,
  onCancelAll,
  children,
  overlayClassName,
}: DestinationPickerPanelProps) {
  // collapsed(2026-09-02新設): カードが地図・目的地ピンを覆い隠して見えなく
  // なってしまう(特に画面の狭いスマートフォン)という指摘への対応。カード右上の
  // シェブロンボタンで、内容を隠して地図を確認できる小さなピル状のボタンだけに
  // 折りたためるようにする。ステップ(choose/picking)を切り替えても折りたたみ
  // 状態はリセットしない(地図を確認したい理由はどちらのステップでも変わらない
  // ため)。
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      // pointer-events-none(2026-09-02修正、PC画面でモーダル横に目的地ピンを
      // 置けない不具合の対応): この折りたたみ状態では中身がボタン1個だけで
      // 見た目上も小さいが、他のステップと同じ構造上の理由でコンテナ自体は
      // 効果としては不要だが念のため統一しておく(下記choose/picking画面の
      // 説明を参照)。
      <div className={`pointer-events-none absolute top-4 left-4 z-10${overlayClassName ? ` ${overlayClassName}` : ""}`}>
        {/* variant="outline"(縁取りのみ・背景透明)は、カードの中でなく地図に
            直接重ねると背景・文字とも地図に溶け込んで読めなくなる。ヘッダー/
            フッター(LiveSession.tsx)と同じ不透明なガラス調背景に統一する
            (2026-09-02修正、ユーザーフィードバックにより他UIとの統一を優先し
            当初のprimary(青塗り)から変更)。 */}
        <Button
          variant="ghost"
          onPress={() => setCollapsed(false)}
          className="pointer-events-auto gap-2 border border-border bg-surface/90 shadow-lg backdrop-blur-sm"
        >
          <MapIcon className="size-4" aria-hidden />
          地図を確認中(タップで再表示)
        </Button>
      </div>
    );
  }

  if (picker.step === "choose") {
    // 2026-09-02修正: 以前は`fixed inset-0`の全画面バックドロップ(bg-black/55)で
    // 包んでいたため、カードの外側(視覚上は素の地図)をタップしても何も
    // 起きない「地図が反応しない範囲」が画面全体に広がってしまっていた。
    // すぐ下のpicking画面(地図タップで地点確定)と同じ、上部に浮かせるだけの
    // 非モーダルな配置に統一し、地図を常にタップ可能なままにする。
    //
    // pointer-events-none/auto(2026-09-02再修正、「PC画面でモーダル横に
    // 目的地ピンを置けない」の対応): 上記の対応後も、このコンテナ自体は
    // `left-4 right-4`で画面幅いっぱいに広がったままだった。カード
    // (max-w-105)は画面の左側に寄って表示されるため、スマホ幅では
    // ほぼ全体を覆い問題が目立たなかったが、PCのような広い画面では
    // カードの右側に「見た目は地図だが実際はこの透明なコンテナが
    // クリックを奪ってしまう」帯ができてしまっていた。コンテナに
    // pointer-events-noneを、実際にクリックを受けるCardにはpointer-events-autoを
    // 指定し、コンテナの透明な部分だけクリックを地図へ素通りさせる
    // (ヘッダー/フッター等で使っている.cocode-topbarと同じ考え方)。
    return (
      <div
        className={`pointer-events-none absolute top-4 left-4 right-4 z-10 flex flex-wrap items-start justify-center gap-3${overlayClassName ? ` ${overlayClassName}` : ""}`}
      >
        <Card className="pointer-events-auto flex w-full max-w-105 flex-col gap-4.5 p-7">
          <div className="flex items-start justify-between gap-3">
            {title && <p className="text-sm text-muted">{title}</p>}
            <Button isIconOnly variant="ghost" size="sm" onPress={() => setCollapsed(true)} className="shrink-0" aria-label="地図を確認するため折りたたむ">
              <ChevronUp className="size-4" aria-hidden />
            </Button>
          </div>

          <Button variant="outline" onPress={picker.useCurrentLocation} isDisabled={picker.locating}>
            <LocateFixed className="size-4.5" aria-hidden />
            {picker.locating ? "取得中…" : "現在地を使う"}
          </Button>
          <Button variant="outline" onPress={picker.chooseFromMap} isDisabled={picker.locating}>
            <MapIcon className="size-4.5" aria-hidden />
            地図から選択する
          </Button>

          <hr className="my-0.5 border-border" />

          <div className="flex flex-col gap-2">
            <Label htmlFor="cocode-dest-address-input" className="flex items-center gap-1.5">
              <Search className="size-4" aria-hidden />
              住所で検索
            </Label>
            <div className="flex gap-2">
              <Input
                id="cocode-dest-address-input"
                type="text"
                value={picker.addressQuery}
                onChange={(e) => picker.setAddressQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") picker.runAddressSearch();
                }}
                placeholder="例: 渋谷駅"
                fullWidth
                className="min-w-0 flex-1"
              />
              <Button variant="outline" onPress={picker.runAddressSearch} isDisabled={picker.searching} className="shrink-0 whitespace-nowrap">
                {picker.searching ? "検索中…" : "検索"}
              </Button>
            </div>
            {picker.addressResults.length > 0 && (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {picker.addressResults.map((r, i) => (
                  <li key={i}>
                    <Button variant="outline" fullWidth className="justify-start text-left font-normal" onPress={() => picker.pickAddressResult(r)}>
                      {r.label}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {picker.error && <p className="text-sm text-danger">{picker.error}</p>}

          {onCancelAll && (
            <Button variant="outline" onPress={onCancelAll}>
              キャンセル
            </Button>
          )}
        </Card>
      </div>
    );
  }

  // pointer-events-none/auto(2026-09-02再修正、「PC画面でモーダル横に目的地
  // ピンを置けない」の対応): choose画面と同じ理由。picking画面はまさに
  // 「地図をタップしてピンの位置を決める」段階であり、この不具合の影響が
  // 最も直接的に現れる場所だった。
  return (
    <div
      className={`pointer-events-none absolute top-4 left-4 right-4 z-10 flex flex-wrap items-start justify-between gap-3${overlayClassName ? ` ${overlayClassName}` : ""}`}
    >
      <Card className="pointer-events-auto flex w-full max-w-85 flex-col gap-3 p-4.5">
        <div className="flex items-start justify-between gap-3">
          {picker.point ? (
            <p className="text-sm text-muted">
              {picker.point.address
                ? `「${picker.point.address}」を`
                : `地点を選択しました(${picker.point.lat.toFixed(5)}, ${picker.point.lng.toFixed(5)})を`}
              目的地とします。
            </p>
          ) : (
            <p className="text-sm text-muted">地図をタップして目的地を指定してください。</p>
          )}
          <Button isIconOnly variant="ghost" size="sm" onPress={() => setCollapsed(true)} className="shrink-0" aria-label="地図を確認するため折りたたむ">
            <ChevronUp className="size-4" aria-hidden />
          </Button>
        </div>

        {picker.point && (
          <>
            {children}
            <Button variant="primary" onPress={onConfirm} isDisabled={confirming}>
              {confirming ? "処理中…" : confirmLabel}
            </Button>
          </>
        )}

        <Button variant="outline" onPress={picker.reselect} isDisabled={confirming}>
          選びなおす
        </Button>
        {onCancelAll && (
          <Button variant="outline" onPress={onCancelAll} isDisabled={confirming}>
            キャンセル
          </Button>
        )}

        {picker.error && <p className="text-sm text-danger">{picker.error}</p>}
      </Card>
    </div>
  );
}
