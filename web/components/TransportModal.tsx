"use client";

import { TransportPicker } from "./TransportPicker";
import { useTransportEtaOptions, type TrainRouteInfo } from "@/lib/useTransportEtaOptions";
import type { LocationState, TransportMode } from "@/lib/types";

interface TransportModalProps {
  currentMode: TransportMode;
  myLive: LocationState | null;
  target: LocationState | null;
  onClose: () => void;
  /** 電車モード選択時、routeにNAVITIMEの経路形状(取得できていれば)を渡す
   * (2026-08-31実装)。呼び出し元はこれをそのまま送信に使い、選択直後に
   * 同じ内容を計算し直す(=有料APIをもう一度叩く)のを避けられる。 */
  onSelect: (mode: TransportMode, etaSeconds?: number, route?: TrainRouteInfo) => void;
}

// 移動手段切替モーダル(2026-08-31新設、2026-08-31再改訂)。開いた時点で
// 徒歩・車・電車すべての目安所要時間をまとめて取得し(useTransportEtaOptions、
// ホストの作成フロー・ゲストの参加フローと共通)、各ボタンの下に表示する。
// タップした瞬間に(既に取得済みの値で)即座に確定するため、以前のような
// クリックごとの計算待ちは発生しない。現在地または目的地が不明な場合は
// 所要時間なしで手段だけ切り替わる(サーバー側で後から自動再計算される、
// LiveSession.tsxの自動ETA計算エフェクト参照)。
export function TransportModal({ currentMode, myLive, target, onClose, onSelect }: TransportModalProps) {
  const { etaByMode, trainRoute } = useTransportEtaOptions(myLive, target);

  function selectMode(mode: TransportMode) {
    onSelect(mode, etaByMode[mode], mode === "train" ? (trainRoute ?? undefined) : undefined);
    onClose();
  }

  return (
    <div className="cocode-modal-backdrop" onClick={onClose}>
      <div className="cocode-glass cocode-modal" onClick={(e) => e.stopPropagation()}>
        <p className="cocode-modal-title">移動手段を選択</p>
        {(!myLive || !target) && (
          <p className="cocode-hint">現在地または目的地が不明なため、所要時間は計算されません。</p>
        )}
        <TransportPicker value={currentMode} onChange={selectMode} etaByMode={etaByMode} />
        <button className="cocode-btn cocode-btn-secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
