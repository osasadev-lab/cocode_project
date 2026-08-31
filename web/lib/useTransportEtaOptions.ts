import { useEffect, useRef, useState } from "react";
import { computeTransitEta } from "./api";
import { fetchRouteDurationSeconds } from "./routing";
import type { LocationState, RouteStep, TransportMode } from "./types";

export type TransportEtaMap = Partial<Record<TransportMode, number>>;
export interface TrainRouteInfo {
  polyline?: string;
  steps?: RouteStep[];
}

// useTransportEtaOptions: 徒歩・車・電車すべての目安所要時間をまとめて取得する
// (2026-08-31新設)。ホストの作成フロー(CreateForm)・ゲストの参加フロー
// (LiveSessionの割り込みステップ)・フッター/メンバー一覧からの変更
// (TransportModal)の3箇所で、移動手段選択と同時に共通の見た目で所要時間を
// 表示できるようにするための共有ロジック。取得に失敗したモードは黙って
// 欠落させる(既存のETA計算箇所と同じ「静かに無視する」方針)。
//
// 電車モードの経路形状(trainRoute)もここで一緒に保持しておく
// (2026-08-31実装、§電車経路描画)。TransportModalが選択確定時にこの値を
// そのまま送信に使うことで、選択直後にLiveSession.tsxの自動ETA計算
// エフェクトが同じ内容をもう一度取得し直す(=NAVITIMEの有料API呼び出しを
// 無駄に2倍消費する)のを避けられる。
//
// 世代カウンタ(requestIdRef)で「追い越されたレスポンスの破棄」だけを行い、
// 「同じキーなら開始自体をスキップする」方式は採らない(2026-08-31修正:
// TransportModal.tsxのように、マウント時点で既にmyLive/targetが揃っている
// コンポーネントでは、React StrictMode(開発時)のmount→cleanup→remountで
// 1回目のフェッチがcancelled扱いになった直後、2回目の実行が「同じキーは
// 処理済み」と誤認してフェッチ自体を開始せず、ETAが永遠に空のままになる
// 不具合があった)。
export function useTransportEtaOptions(
  myLive: LocationState | null,
  target: LocationState | null
): { etaByMode: TransportEtaMap; trainRoute: TrainRouteInfo | null; loading: boolean } {
  const [etaByMode, setEtaByMode] = useState<TransportEtaMap>({});
  const [trainRoute, setTrainRoute] = useState<TrainRouteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!myLive || !target) {
      requestIdRef.current += 1;
      setEtaByMode({});
      setTrainRoute(null);
      setLoading(false);
      return;
    }
    const thisRequestId = ++requestIdRef.current;
    setLoading(true);
    (async () => {
      const [walk, car, train] = await Promise.all([
        fetchRouteDurationSeconds(myLive, target, "walk").catch(() => null),
        fetchRouteDurationSeconds(myLive, target, "car").catch(() => null),
        computeTransitEta(myLive.lat, myLive.lng, target.lat, target.lng).catch(() => null),
      ]);
      if (thisRequestId !== requestIdRef.current) return; // 新しいリクエストに追い越された場合は結果を破棄
      const next: TransportEtaMap = {};
      if (walk != null) next.walk = walk;
      if (car != null) next.car = car;
      if (train != null) next.train = train.etaSeconds;
      setEtaByMode(next);
      setTrainRoute(train ? { polyline: train.polyline || undefined, steps: train.steps } : null);
      setLoading(false);
    })();
    // myLive/targetはオブジェクトとして毎レンダー新規に生成されるため、
    // 値そのもの(プリミティブ)を依存にする(LiveSession.tsxの既存の
    // 自動ETA計算エフェクトと同じ理由)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myLive?.lat, myLive?.lng, target?.lat, target?.lng]);

  return { etaByMode, trainRoute, loading };
}
