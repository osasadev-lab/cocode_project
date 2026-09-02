import { haversineMeters } from "./geolocation";

// 経路線(ポリライン)に関する幾何演算をまとめたユーティリティ(仕様書§9.2)。
// MapView.tsx(経路線の描画・進行に伴うトリミング)とLiveSession.tsx
// (電車モードの経路逸脱検知)の双方から参照される、副作用の無い純粋関数のみで
// 構成している。

/** [lng, lat] のペア。MapLibre・NAVITIMEの座標順序に合わせている。 */
export type LngLat = [number, number];

/**
 * 電車モードの経路線(NAVITIME経由、`[lng,lat]`のペアの配列をJSON化した文字列、
 * 仕様書§7.1.1)を座標配列にデコードする。壊れたデータ・想定外の形状は
 * 黙って`null`を返す(呼び出し元は直線フォールバック等へ切り替えること)。
 */
export function parseTrainPolyline(polyline: string): LngLat[] | null {
  try {
    const parsed = JSON.parse(polyline);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const coords: LngLat[] = [];
    for (const p of parsed) {
      if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number") return null;
      coords.push([p[0], p[1]]);
    }
    return coords;
  } catch {
    return null;
  }
}

interface NearestPointResult {
  /** coords のうち、最近傍点が乗っている線分の始点インデックス。 */
  segmentIndex: number;
  /** 線分上で current に最も近い点(垂線の足。区間外なら端点にクランプ)。 */
  point: LngLat;
  /** current から point までの距離(メートル)。 */
  distanceMeters: number;
}

/**
 * current から見て、coords(折れ線)上で最も近い点を探す。各線分ごとに
 * 垂線の足を計算し、最小距離のものを採用する単純な総当たりで十分な精度が
 * 出る(経路の頂点数は多くても数百程度で、リアルタイム性を損なわない)。
 *
 * 緯度経度は厳密には平面ではないが、隣接する折れ線の頂点間(通常は数十〜
 * 数百m程度)という局所的な範囲では、経度方向を cos(緯度) で補正した単純な
 * 平面近似で十分な精度が得られる(既存のhaversineMeters実装と同じ割り切り方)。
 */
function nearestPointOnLine(coords: LngLat[], current: { lat: number; lng: number }): NearestPointResult {
  if (coords.length === 1) {
    const [lng, lat] = coords[0];
    return { segmentIndex: 0, point: coords[0], distanceMeters: haversineMeters(current, { lat, lng }) };
  }

  const latRad = (current.lat * Math.PI) / 180;
  const lngScale = Math.cos(latRad);
  const px = current.lng * lngScale;
  const py = current.lat;

  let best: NearestPointResult | null = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLng, aLat] = coords[i];
    const [bLng, bLat] = coords[i + 1];
    const ax = aLng * lngScale;
    const ay = aLat;
    const bx = bLng * lngScale;
    const by = bLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projLng = aLng + (bLng - aLng) * t;
    const projLat = aLat + (bLat - aLat) * t;
    const distanceMeters = haversineMeters(current, { lat: projLat, lng: projLng });
    if (!best || distanceMeters < best.distanceMeters) {
      best = { segmentIndex: i, point: [projLng, projLat], distanceMeters };
    }
  }
  return best as NearestPointResult;
}

/**
 * current から見た、経路(coords)からの逸脱距離(メートル)を返す
 * (仕様書§9.2「経路からの逸脱検知」)。coords が空の場合は0(判定不能として
 * 逸脱なし扱い)。
 */
export function distanceFromRouteMeters(coords: LngLat[], current: { lat: number; lng: number }): number {
  if (coords.length === 0) return 0;
  return nearestPointOnLine(coords, current).distanceMeters;
}

/**
 * current に最も近い点より手前(通過済み)の区間を切り詰め、残りの区間だけを
 * 返す(仕様書§9.2「経路線の進行に伴う消去」)。先頭は current との最近傍点
 * (線分上の補間点、現在地とほぼ同じ座標)に置き換わるため、描画上は経路の
 * 始点が常に現在地に一致する。coords の要素数が1以下の場合はそのまま返す。
 */
export function trimRouteToPosition(coords: LngLat[], current: { lat: number; lng: number }): LngLat[] {
  if (coords.length <= 1) return coords;
  const nearest = nearestPointOnLine(coords, current);
  return [nearest.point, ...coords.slice(nearest.segmentIndex + 1)];
}
