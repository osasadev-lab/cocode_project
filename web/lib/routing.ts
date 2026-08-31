import type { LocationState } from "./types";

// OSRM 経路探索(徒歩・車)。プロファイル(徒歩/車)ごとに別ホストを持つ、
// FOSSGISが公開しているOSRMインスタンスを使う(無料・APIキー不要)。
//
// 2026-08-31改訂: 従来使っていた router.project-osrm.org(OSRM公式のデモ
// サーバー)は、foot/drivingどちらのプロファイルを指定しても常に同一の結果
// (weight_name: "routability"、車速ベースの経路・所要時間)を返すことが
// 検証で判明した — 徒歩プロファイルが実装されておらず、常にcarプロファイルに
// フォールバックしている。このため徒歩モードの目安所要時間は実際には車速
// (検証時: 時速30〜55km相当)で計算されており、長距離ほど実際より大幅に
// 短く表示される不具合があった。プロファイルごとに別ホストを持つFOSSGISの
// インスタンスに切り替え、徒歩は約4.5km/h・車は約39km/hと、それぞれ現実的な
// 速度になることを確認済み。信頼性が問題になった場合は、セルフホストまたは
// 有料のOSRM/ORSインスタンスにこのURLを差し替える。
const OSRM_BASE_URL: Record<"walk" | "car", string> = {
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  car: "https://routing.openstreetmap.de/routed-car/route/v1/car",
};

// OSRMが返す所要時間が示す実勢速度が、この上限(km/h)を超えていたら異常値と
// みなす安全弁(2026-08-31新設)。サーバー側のプロファイル設定不備・障害が
// 再発した場合でも、非現実的な値(例: 徒歩なのに車並みの速度)をそのまま
// ユーザーへ見せてしまわないようにする。
const MAX_PLAUSIBLE_SPEED_KMH: Record<"walk" | "car", number> = {
  walk: 8, // 早歩き・小走りやGPS誤差を見込んでも通常この程度が上限
  car: 120, // 高速道路走行を見込んだ上限
};

// 上限を超えた場合に代わりに使う、市街地移動を想定した目安巡航速度。
const FALLBACK_CRUISE_KMH: Record<"walk" | "car", number> = {
  walk: 4.8, // 一般的な成人の歩行速度
  car: 25, // 信号待ち等を見込んだ市街地の目安速度
};

// plausibleDurationSeconds は、距離に対して所要時間が非現実的な場合に
// 目安巡航速度から再計算した値へ差し替える。戻り値は必ず整数秒にする
// (サーバー側のETASecondsが*int型のため、小数のまま送るとJSONの
// アンマーシャルに失敗してWebSocket接続そのものが切断されてしまう)。
function plausibleDurationSeconds(
  profile: "walk" | "car",
  distanceMeters: number,
  durationSeconds: number
): number {
  if (durationSeconds <= 0) return Math.round(durationSeconds);
  const impliedKmh = distanceMeters / 1000 / (durationSeconds / 3600);
  if (impliedKmh <= MAX_PLAUSIBLE_SPEED_KMH[profile]) return Math.round(durationSeconds);
  return Math.round((distanceMeters / 1000 / FALLBACK_CRUISE_KMH[profile]) * 3600);
}

/**
 * 徒歩/車ルートを [lng, lat] の座標列として取得する。ルートが見つからない場合
 * （通信失敗、経路が存在しない、サーバー不調など）は null を返す。
 * これはあくまで補助的な情報であり中核機能ではないため、呼び出し元は
 * null を「エラーとしてユーザーに見せる」のではなく「線を描かない」として扱うこと。
 */
export async function fetchRoute(
  from: LocationState,
  to: LocationState,
  profile: "walk" | "car",
  signal?: AbortSignal
): Promise<[number, number][] | null> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${OSRM_BASE_URL[profile]}/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      code: string;
      routes?: { geometry: { coordinates: [number, number][] } }[];
    };
    if (body.code !== "Ok" || !body.routes?.length) return null;
    return body.routes[0].geometry.coordinates;
  } catch {
    return null;
  }
}

// fetchRouteDurationSeconds は徒歩/車の所要時間(秒)を取得する
// （移動手段切替時のETA計算用）。距離に対して所要時間が非現実的な場合は
// plausibleDurationSeconds で補正する。ルートが見つからない場合はnull。
export async function fetchRouteDurationSeconds(
  from: LocationState,
  to: LocationState,
  profile: "walk" | "car",
  signal?: AbortSignal
): Promise<number | null> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${OSRM_BASE_URL[profile]}/${coords}?overview=false`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { code: string; routes?: { duration: number; distance: number }[] };
    if (body.code !== "Ok" || !body.routes?.length) return null;
    const { duration, distance } = body.routes[0];
    return plausibleDurationSeconds(profile, distance, duration);
  } catch {
    return null;
  }
}
