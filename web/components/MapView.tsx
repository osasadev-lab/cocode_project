"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import maplibregl, { type LngLatLike } from "maplibre-gl";
import { currentMapStyleUrl, isDarkHours } from "@/lib/mapStyle";
import { fetchRoute } from "@/lib/routing";
import type { LiveParticipant, LocationState } from "@/lib/types";

// OSRMで経路取得する移動手段("walk"|"car")。電車モードはOSRMを使わず、
// 別ロジック(drawTrainRoute参照)で描画する。
type RouteProfile = "walk" | "car";
function routeProfileFor(mode: LiveParticipant["transportMode"]): RouteProfile | null {
  return mode === "walk" || mode === "car" ? mode : null;
}

// parseTrainPolyline: サーバー(NAVITIME経由)から届いたroutePolyline
// (JSON文字列、[lng,lat]のペアの配列)をMapLibreの座標配列にデコードする
// (2026-08-31実装、§電車経路描画)。壊れたデータ・想定外の形状は黙って
// nullを返す(呼び出し元は直線フォールバックへ切り替える)。
function parseTrainPolyline(polyline: string): [number, number][] | null {
  try {
    const parsed = JSON.parse(polyline);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const coords: [number, number][] = [];
    for (const p of parsed) {
      if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number") return null;
      coords.push([p[0], p[1]]);
    }
    return coords;
  } catch {
    return null;
  }
}

// ダーク/ライトの時間帯境界(18:00, 4:00)をまたいだかを再判定する間隔（仕様書§4）。
const STYLE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

interface MapViewProps {
  target: LocationState | null;
  /** 自分を含む、ライブ位置が取得できている全参加者（N人対応、仕様書§5.1・§8）。 */
  participants: LiveParticipant[];
  /** true の場合、地図タップ時にパンではなく onPickTarget 経由で座標を通知する
   * （ホストが待ち合わせ地点を選んでいる間に使う）。 */
  pickingTarget?: boolean;
  onPickTarget?: (lat: number, lng: number) => void;
  /** 値が変化するたびに、自分のライブ位置へ地図をflyToする
   * （「現在地に戻る」ボタン用、2026-08-31新設）。 */
  recenterSignal?: number;
  /** 値が変化するたびに、表示中の全地点(目的地・全参加者のライブ位置)が
   * 収まるよう地図をfitBoundsする（「全員をマップに収める」ボタン用、2026-08-31新設）。 */
  fitAllSignal?: number;
  /** 値が変化するたびに、targetの地点へ地図をflyToする（フッターの
   * 「目的地」ボタン用、2026-08-31新設）。flyToTargetSignal(下記、地点選択
   * フロー専用)とは独立したシグナルとして分離している。 */
  focusTargetSignal?: number;
  /** 値が変化するたびに、targetの地点へ地図をflyToする（住所検索の候補選択・
   * 「現在地を使う」など、地図タップ以外の方法でtargetが決まった場合用、
   * 2026-08-31新設）。初回マウント時のfitBounds(maybeFitBounds)とは別に、
   * 2回目以降のtarget変更でも地図を追従させるためのシグナル。 */
  flyToTargetSignal?: number;
}

// MapLibre の地図を表示し、待ち合わせ地点・全参加者のライブ位置・
// 徒歩/車ルートのプレビューを重ねて描画するコンポーネント。

// emptyLine / lineFromCoords: ルート表示用の GeoJSON LineString を組み立てるヘルパー。
function emptyLine(): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
}

function lineFromCoords(coords: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

function routeSourceId(participantId: string): string {
  return `cocode-route-${participantId}`;
}

function routeLayerId(participantId: string): string {
  return `cocode-route-${participantId}-line`;
}

// upsertMarker はマーカー要素を最初の呼び出し時にだけ作成し、以降は
// 同じインスタンスを使い回す。待ち合わせ地点マーカー用に、クラス名・
// アンカー・絵文字だけを指定すればよいようにしている(ライブ位置マーカーは
// upsertLiveMarkerを使う、下記参照)。
function upsertMarker(
  map: maplibregl.Map,
  ref: MutableRefObject<maplibregl.Marker | null>,
  opts: { className: string; anchor: "bottom" | "center"; text?: string },
  lngLat: LngLatLike
): void {
  if (!ref.current) {
    const el = document.createElement("div");
    el.className = opts.className;
    if (opts.text) el.textContent = opts.text;
    ref.current = new maplibregl.Marker({ element: el, anchor: opts.anchor });
  }
  ref.current.setLngLat(lngLat).addTo(map);
}

interface LiveMarkerEntry {
  marker: maplibregl.Marker;
  labelEl: HTMLSpanElement;
  iconEl: HTMLImageElement;
  badgeEl: HTMLSpanElement;
}

// upsertLiveMarker はライブ位置マーカー(アバター状の円+ネームタグ)を、
// participantIdをキーにしたMapで作成・更新する（N人対応、仕様書§8）。
// 名前・アイコンが変わった場合(プロフィール編集機能用)に備え、
// ラベル・アイコン要素は毎回内容を更新する。到着済み(仕様書§12.1-①)の
// 場合はアバターの右上に🏁バッジを表示する。
function upsertLiveMarker(
  map: maplibregl.Map,
  markersRef: MutableRefObject<Map<string, LiveMarkerEntry>>,
  id: string,
  opts: { tone: "a" | "b"; label: string; avatarSrc?: string; arrived?: boolean },
  lngLat: LngLatLike
): void {
  let entry = markersRef.current.get(id);
  if (!entry) {
    const wrap = document.createElement("div");
    wrap.className = "cocode-marker-live-wrap";
    const ring = document.createElement("div");
    ring.className = `cocode-marker-avatar cocode-marker-${opts.tone}`;
    const pulse = document.createElement("span");
    pulse.className = "cocode-marker-pulse";
    const icon = document.createElement("img");
    icon.className = "cocode-marker-avatar-icon";
    icon.alt = "";
    const badge = document.createElement("span");
    badge.className = "cocode-marker-arrived-badge";
    badge.textContent = "🏁";
    badge.hidden = true;
    ring.appendChild(pulse);
    ring.appendChild(icon);
    ring.appendChild(badge);
    const label = document.createElement("span");
    label.className = "cocode-marker-name-tag";
    wrap.appendChild(ring);
    wrap.appendChild(label);
    entry = {
      marker: new maplibregl.Marker({ element: wrap, anchor: "center" }),
      labelEl: label,
      iconEl: icon,
      badgeEl: badge,
    };
    markersRef.current.set(id, entry);
  }
  entry.labelEl.textContent = opts.label;
  if (opts.avatarSrc && entry.iconEl.src !== opts.avatarSrc) {
    entry.iconEl.src = opts.avatarSrc;
  }
  entry.badgeEl.hidden = !opts.arrived;
  entry.marker.setLngLat(lngLat).addTo(map);
}

// createRouteUpdater は、1人ぶんの経路描画リクエストの重複を防ぐクロージャを
// 作る。両端点・移動手段(・電車モードの場合はpolylineの中身)が変わって
// いなければ再描画をスキップし、より新しいリクエストで上書きされた場合は
// 古い応答を無視/中断する（fetch の応答順序はリクエスト順と一致するとは
// 限らないため）。デバウンスは行わない — GPS の更新自体が既に上流で
// スロットリングされているため（LIVE_UPDATE_MIN_DISTANCE_M/MS）。
//
// 徒歩/車はOSRMから取得した実際の道路経路を描く。電車モード
// (profile=null)は、NAVITIMEの経路形状(trainPolyline)が取得できていれば
// それを実際の乗換経路として描き、取得できていない場合(ジョルダン利用時・
// NAVITIMEの/shape_transitが失敗した場合など)は現在地→目的地の直線で
// 代替する(2026-08-31実装、§電車経路描画。ユーザー確認済み: 無料枠を
// 使い切ったら直線表示にフォールバックする方針)。
function createRouteUpdater(setLine: (coords: [number, number][]) => void) {
  let lastKey = "";
  let requestId = 0;
  let abortController: AbortController | null = null;

  function update(
    from: LocationState | null,
    to: LocationState | null,
    profile: RouteProfile | null,
    isTrain: boolean,
    trainPolyline?: string
  ) {
    if (isTrain) {
      abortController?.abort();
      if (!from || !to) {
        lastKey = "";
        setLine([]);
        return;
      }
      const key = trainPolyline ? `train-shape|${trainPolyline}` : `train-straight|${from.lat},${from.lng}|${to.lat},${to.lng}`;
      if (key === lastKey) return;
      lastKey = key;
      const shapeCoords = trainPolyline ? parseTrainPolyline(trainPolyline) : null;
      setLine(shapeCoords ?? [[from.lng, from.lat], [to.lng, to.lat]]);
      return;
    }
    if (!from || !to || !profile) {
      lastKey = "";
      abortController?.abort();
      setLine([]);
      return;
    }
    const key = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
    if (key === lastKey) return;
    lastKey = key;

    const thisRequestId = ++requestId;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    fetchRoute(from, to, profile, controller.signal).then((coords) => {
      if (thisRequestId !== requestId) return; // 新しいリクエストに追い越された場合は結果を破棄
      if (coords) setLine(coords);
    });
  }

  // abort: 未解決のOSRMリクエストを中断する(2026-09-01新設)。MapView
  // アンマウント時(mapインスタンス破棄後)に呼ぶことで、破棄後に応答が
  // 遅れて届いてsetLineが呼ばれ、既に破棄されたmapへ.getSource()して
  // クラッシュする不具合("Cannot read properties of undefined (reading
  // 'getSource')")を防ぐ。fetchRouteは中断時nullを返す(web/lib/routing.ts)
  // ため、中断後はsetLineが呼ばれなくなる。
  function abort() {
    abortController?.abort();
  }

  return { update, abort };
}

// addRouteLayerForId は1参加者ぶんの経路レイヤー(source+line layer)を
// まだ無ければ作成する。スタイルがロード未完了の間はaddSourceが例外を
// 投げるため、真偽値のチェックではなく例外の有無で準備完了を判定する
// （呼び出し元がstyledataイベントでリトライする）。
function addRouteLayerForId(
  map: maplibregl.Map,
  id: string,
  color: string,
  readyIds: Set<string>,
  updaters: Map<string, ReturnType<typeof createRouteUpdater>>
): boolean {
  if (readyIds.has(id)) return true;
  try {
    map.addSource(routeSourceId(id), { type: "geojson", data: emptyLine() });
  } catch {
    return false;
  }
  // 破線にしているのは、確定ルートではなく目安の経路であることを示すため
  // （無料・ベストエフォートのルーティングサービスによる徒歩/車ルート）。
  map.addLayer({
    id: routeLayerId(id),
    type: "line",
    source: routeSourceId(id),
    paint: { "line-color": color, "line-width": 3, "line-opacity": 0.65, "line-dasharray": [2, 2] },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  readyIds.add(id);
  if (!updaters.has(id)) {
    updaters.set(
      id,
      createRouteUpdater((coords) => {
        (map.getSource(routeSourceId(id)) as maplibregl.GeoJSONSource | undefined)?.setData(lineFromCoords(coords));
      })
    );
  }
  return true;
}

function removeRouteLayerForId(
  map: maplibregl.Map,
  id: string,
  readyIds: Set<string>,
  updaters: Map<string, ReturnType<typeof createRouteUpdater>>
): void {
  if (map.getLayer(routeLayerId(id))) map.removeLayer(routeLayerId(id));
  if (map.getSource(routeSourceId(id))) map.removeSource(routeSourceId(id));
  readyIds.delete(id);
  updaters.get(id)?.abort();
  updaters.delete(id);
}

export function MapView({
  target,
  participants,
  pickingTarget,
  onPickTarget,
  recenterSignal,
  fitAllSignal,
  focusTargetSignal,
  flyToTargetSignal,
}: MapViewProps) {
  // マップ本体・マーカー各種は MapLibre の命令的 API を扱うため ref で保持する
  // （React の再レンダリングごとに作り直さないようにするため）。
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const markersRef = useRef<Map<string, LiveMarkerEntry>>(new Map());
  const hasFitRef = useRef(false);
  const recenterSeenRef = useRef(recenterSignal);
  const fitAllSeenRef = useRef(fitAllSignal);
  const focusTargetSeenRef = useRef(focusTargetSignal);
  const flyToTargetSeenRef = useRef(flyToTargetSignal);
  const onPickTargetRef = useRef(onPickTarget);
  onPickTargetRef.current = onPickTarget;
  const pickingTargetRef = useRef(pickingTarget);
  pickingTargetRef.current = pickingTarget;
  // 経路(徒歩/車)は participantId ごとに独立した source/layer/updater を持つ
  // （N人対応、仕様書§8）。electric train モードの経路描画は別タスク(§4)で扱う。
  const activeRouteIdsRef = useRef<Set<string>>(new Set());
  const routeSourcesReadyRef = useRef<Set<string>>(new Set());
  const routeUpdatersRef = useRef<Map<string, ReturnType<typeof createRouteUpdater>>>(new Map());
  const routeColorRef = useRef<Map<string, string>>(new Map());
  // ensureRouteLayers（後述）が、その時点で分かっている最新の props ですぐ
  // 経路を再計算できるようにするための最新値スナップショット。fitAllSignal・
  // スタイル切替後の経路再セットアップなど、レンダーを介さず読みたい箇所で使う。
  const latestPropsRef = useRef({ target, participants });
  latestPropsRef.current = { target, participants };
  // 直近に適用したダーク/ライト判定（再判定の際、変化した場合のみsetStyleするため）。
  const isDarkRef = useRef(isDarkHours());

  // ensureRouteLayers: activeRouteIdsRef に載っている全参加者ぶんの経路
  // レイヤーが揃うようにし、揃った時点で最新位置での再描画も行う。
  // スタイル未ロードでレイヤー作成に失敗した参加者がいれば、"styledata"で
  // 再試行する（初回マウント時・ダーク/ライト切替直後の両方で必要になる）。
  function ensureRouteLayers() {
    const map = mapRef.current;
    if (!map) return;
    const tryAll = () => {
      let allReady = true;
      for (const id of activeRouteIdsRef.current) {
        const color = routeColorRef.current.get(id) ?? "#f97316";
        if (!addRouteLayerForId(map, id, color, routeSourcesReadyRef.current, routeUpdatersRef.current)) {
          allReady = false;
        }
      }
      return allReady;
    };
    if (tryAll()) {
      runRouteUpdaters(map);
      return;
    }
    const onStyleData = () => {
      if (tryAll()) {
        runRouteUpdaters(map);
        map.off("styledata", onStyleData);
      }
    };
    map.on("styledata", onStyleData);
  }

  function runRouteUpdaters(map: maplibregl.Map) {
    const { target: t, participants: ps } = latestPropsRef.current;
    for (const p of ps) {
      routeUpdatersRef.current.get(p.id)?.update(
        { lat: p.lat, lng: p.lng, updatedAt: "" },
        t,
        routeProfileFor(p.transportMode),
        p.transportMode === "train",
        p.routePolyline
      );
    }
  }

  // 地図インスタンスの生成。マウント時に一度だけ実行し、アンマウント時に破棄する。
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: currentMapStyleUrl(),
      center: [139.767, 35.681],
      zoom: 12,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    // 地図タップ時、待ち合わせ地点選択モードなら座標を親コンポーネントへ通知する。
    // pickingTargetがtrueの間だけタップを目的地候補として通知する
    // (2026-08-31修正: 以前はこのチェックが無く、目的地変更モードでない
    // 通常のライブマップ画面でも地図タップだけで目的地プレビューが
    // 動いてしまう不具合があった)。
    map.on("click", (e) => {
      if (!pickingTargetRef.current) return;
      onPickTargetRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });

    // ダーク/ライト時間帯の境界(18:00, 4:00)をまたいだかを定期的に再判定し、
    // 変化していれば地図スタイルを切り替える（仕様書§4）。DOM Markerはスタイルと
    // 独立して地図に紐づいているため、setStyle後も再登録は不要。経路の
    // source/layerはsetStyleで失われるため、readyIds/updatersをクリアした上で
    // ensureRouteLayersにより再登録する(updatersもクリアするのは、lastKeyが
    // 残ったままだと位置が変わっていない限り再描画がスキップされ、切替直後の
        // 経路線が空のままになってしまうため)。
    const styleCheckId = setInterval(() => {
      const dark = isDarkHours();
      if (dark === isDarkRef.current) return;
      isDarkRef.current = dark;
      routeSourcesReadyRef.current.clear();
      routeUpdatersRef.current.clear();
      map.setStyle(currentMapStyleUrl());
      ensureRouteLayers();
    }, STYLE_RECHECK_INTERVAL_MS);

    mapRef.current = map;
    return () => {
      clearInterval(styleCheckId);
      // 未解決のOSRM経路取得リクエストを中断してからmapを破棄する(2026-09-01
      // 修正): 中断せずに破棄すると、破棄後に応答が遅れて届いた際、
      // setLineが破棄済みのmapへ.getSource()してクラッシュしていた
      // ("Cannot read properties of undefined (reading 'getSource')")。
      for (const updater of routeUpdatersRef.current.values()) updater.abort();
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      activeRouteIdsRef.current.clear();
      routeSourcesReadyRef.current.clear();
      routeUpdatersRef.current.clear();
      routeColorRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // maybeFitBounds: 初回のみ、表示中の地点（待ち合わせ地点・全参加者のライブ位置）が
  // すべて収まるようにカメラを1度だけ調整する。以降は自動追従しない
  // （ユーザーが自由に地図を操作できるようにするため）。
  function maybeFitBounds(map: maplibregl.Map) {
    if (hasFitRef.current) return;
    const points: LngLatLike[] = [];
    if (target) points.push([target.lng, target.lat]);
    for (const p of participants) points.push([p.lng, p.lat]);
    if (points.length === 0) return;
    if (points.length === 1) {
      map.jumpTo({ center: points[0], zoom: 15 });
    } else {
      const bounds = points
        .slice(1)
        .reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
      map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 0 });
    }
    hasFitRef.current = true;
  }

  // 待ち合わせ地点マーカー（🚩）を更新する。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !target) return;
    upsertMarker(
      map,
      targetMarkerRef,
      { className: "cocode-marker cocode-marker-target", anchor: "bottom", text: "🚩" },
      [target.lng, target.lat]
    );
    maybeFitBounds(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // 全参加者(自分含む)のライブ位置マーカー・経路を更新する（N人対応、仕様書§0・§8）。
  // 退出した参加者(participants配列から消えたid)のマーカー・経路レイヤーは
  // ここで確実に削除する（ゴーストマーカー防止、§0の不具合修正の一般化）。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const currentIds = new Set(participants.map((p) => p.id));

    for (const [id, entry] of markersRef.current) {
      if (!currentIds.has(id)) {
        entry.marker.remove();
        markersRef.current.delete(id);
      }
    }
    for (const id of [...activeRouteIdsRef.current]) {
      if (!currentIds.has(id)) {
        removeRouteLayerForId(map, id, routeSourcesReadyRef.current, routeUpdatersRef.current);
        activeRouteIdsRef.current.delete(id);
        routeColorRef.current.delete(id);
      }
    }

    for (const p of participants) {
      activeRouteIdsRef.current.add(p.id);
      routeColorRef.current.set(p.id, p.isSelf ? "#3b82f6" : "#f97316");
      upsertLiveMarker(
        map,
        markersRef,
        p.id,
        { tone: p.isSelf ? "a" : "b", label: p.label, avatarSrc: p.avatarSrc, arrived: p.arrived },
        [p.lng, p.lat]
      );
    }

    ensureRouteLayers();
    maybeFitBounds(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, target]);

  // recenterSignalが変化したら、自分のライブ位置へ地図をflyToする
  // （「現在地に戻る」ボタン、2026-08-31新設）。初回マウント時は発火しない。
  useEffect(() => {
    if (recenterSignal === undefined || recenterSignal === recenterSeenRef.current) return;
    recenterSeenRef.current = recenterSignal;
    const map = mapRef.current;
    const self = participants.find((p) => p.isSelf);
    if (!map || !self) return;
    map.flyTo({ center: [self.lng, self.lat], zoom: Math.max(map.getZoom(), 15), duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterSignal]);

  // fitAllSignalが変化したら、目的地・表示中の全参加者が収まるよう
  // 地図をfitBoundsする（「全員をマップに収める」ボタン、2026-08-31新設）。
  // 初回マウント時は発火しない。
  useEffect(() => {
    if (fitAllSignal === undefined || fitAllSignal === fitAllSeenRef.current) return;
    fitAllSeenRef.current = fitAllSignal;
    const map = mapRef.current;
    if (!map) return;
    const { target: t, participants: ps } = latestPropsRef.current;
    const points: LngLatLike[] = [];
    if (t) points.push([t.lng, t.lat]);
    for (const p of ps) points.push([p.lng, p.lat]);
    if (points.length === 0) return;
    if (points.length === 1) {
      map.flyTo({ center: points[0], zoom: 15, duration: 500 });
      return;
    }
    const bounds = points.slice(1).reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
    map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAllSignal]);

  // focusTargetSignalが変化したら、targetの地点へ地図をflyToする
  // （フッターの「目的地」ボタン、2026-08-31新設）。初回マウント時は発火しない。
  useEffect(() => {
    if (focusTargetSignal === undefined || focusTargetSignal === focusTargetSeenRef.current) return;
    focusTargetSeenRef.current = focusTargetSignal;
    const map = mapRef.current;
    const { target: t } = latestPropsRef.current;
    if (!map || !t) return;
    map.flyTo({ center: [t.lng, t.lat], zoom: Math.max(map.getZoom(), 15), duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTargetSignal]);

  // flyToTargetSignalが変化したら、targetの地点へ地図をflyToする
  // （住所検索の候補選択・「現在地を使う」など、地図タップ以外でtargetが
  // 決まった場合用、2026-08-31新設）。初回マウント時は発火しない。
  useEffect(() => {
    if (flyToTargetSignal === undefined || flyToTargetSignal === flyToTargetSeenRef.current) return;
    flyToTargetSeenRef.current = flyToTargetSignal;
    const map = mapRef.current;
    const { target: t } = latestPropsRef.current;
    if (!map || !t) return;
    map.flyTo({ center: [t.lng, t.lat], zoom: Math.max(map.getZoom(), 15), duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToTargetSignal]);

  return (
    <div ref={containerRef} className={`cocode-map${pickingTarget ? " cocode-map-picking" : ""}`} />
  );
}
