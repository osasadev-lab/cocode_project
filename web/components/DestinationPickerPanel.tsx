"use client";

import type { ReactNode } from "react";
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
  /** picking画面のオーバーレイ(.cocode-topbar)に追加するクラス名。
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
  if (picker.step === "choose") {
    return (
      <div className="cocode-modal-backdrop">
        <div className="cocode-glass cocode-form-card">
          {title && <p className="cocode-subtitle">{title}</p>}

          <button className="cocode-btn cocode-btn-secondary" onClick={picker.useCurrentLocation} disabled={picker.locating}>
            {picker.locating ? "取得中…" : "📍 現在地を使う"}
          </button>
          <button className="cocode-btn cocode-btn-secondary" onClick={picker.chooseFromMap} disabled={picker.locating}>
            🗺️ 地図から選択する
          </button>

          <hr className="cocode-divider" />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="cocode-hint" htmlFor="cocode-dest-address-input">
              🔍 住所で検索
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="cocode-dest-address-input"
                type="text"
                value={picker.addressQuery}
                onChange={(e) => picker.setAddressQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") picker.runAddressSearch();
                }}
                placeholder="例: 渋谷駅"
                className="cocode-text-input"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="cocode-btn cocode-btn-secondary"
                onClick={picker.runAddressSearch}
                disabled={picker.searching}
                style={{ flexShrink: 0, whiteSpace: "nowrap" }}
              >
                {picker.searching ? "検索中…" : "検索"}
              </button>
            </div>
            {picker.addressResults.length > 0 && (
              <ul className="cocode-address-results">
                {picker.addressResults.map((r, i) => (
                  <li key={i}>
                    <button className="cocode-address-result-btn" onClick={() => picker.pickAddressResult(r)}>
                      {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {picker.error && <p className="cocode-error">{picker.error}</p>}

          {onCancelAll && (
            <button className="cocode-btn cocode-btn-secondary" onClick={onCancelAll}>
              キャンセル
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`cocode-topbar${overlayClassName ? ` ${overlayClassName}` : ""}`}>
      <div className="cocode-glass cocode-form-card cocode-picking-card">
        {picker.point ? (
          <p className="cocode-hint">
            {picker.point.address
              ? `「${picker.point.address}」を`
              : `地点を選択しました(${picker.point.lat.toFixed(5)}, ${picker.point.lng.toFixed(5)})を`}
            目的地とします。
          </p>
        ) : (
          <p className="cocode-hint">地図をタップして目的地を指定してください。</p>
        )}

        {picker.point && (
          <>
            {children}
            <button className="cocode-btn cocode-btn-primary" onClick={onConfirm} disabled={confirming}>
              {confirming ? "処理中…" : confirmLabel}
            </button>
          </>
        )}

        <button className="cocode-btn cocode-btn-secondary" onClick={picker.reselect} disabled={confirming}>
          選びなおす
        </button>
        {onCancelAll && (
          <button className="cocode-btn cocode-btn-secondary" onClick={onCancelAll} disabled={confirming}>
            キャンセル
          </button>
        )}

        {picker.error && <p className="cocode-error">{picker.error}</p>}
      </div>
    </div>
  );
}
