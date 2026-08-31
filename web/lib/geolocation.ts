import { useEffect, useRef, useState } from "react";
import { LIVE_UPDATE_MIN_DISTANCE_M, LIVE_UPDATE_MIN_INTERVAL_MS } from "./config";

// GeoPoint: 緯度経度に精度（メートル）を添えた1点の位置情報。
export interface GeoPoint {
  lat: number;
  lng: number;
  accuracy: number;
}

// GeoErrorCode: GeolocationPositionError.codeを分類したもの（仕様書§19.2-1）。
// permission_denied: 明示的に拒否された、またはOS/ブラウザ側でオフ。
// position_unavailable/timeout: 電波状況等による一時的な取得失敗。
export type GeoErrorCode = "permission_denied" | "position_unavailable" | "timeout" | "unsupported";

export interface GeoError {
  code: GeoErrorCode;
  message: string;
}

function toGeoError(err: GeolocationPositionError): GeoError {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return { code: "permission_denied", message: err.message };
    case err.TIMEOUT:
      return { code: "timeout", message: err.message };
    case err.POSITION_UNAVAILABLE:
    default:
      return { code: "position_unavailable", message: err.message };
  }
}

/** 「現在地を使う」ボタン用に、現在位置を1回だけ取得する。 */
export function getCurrentPosition(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject({ code: "unsupported", message: "このブラウザは位置情報の取得に対応していません" } satisfies GeoError);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(toGeoError(err)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// haversineMeters は2点間の距離をハーバーサイン公式で概算する（メートル単位）。
// LiveSession.tsxの「地図マーカーが実際に目的地付近にいる間だけ到着バッジを
// 出す」判定(2026-08-31新設)でも共用するため、GeoPoint(accuracy必須)より
// 緩い{lat,lng}のみの型を受け付けるようにしている。
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * ブラウザの GPS 位置を継続的に監視し（仕様書§5.3）、取得結果を返す。
 * 端末が一定距離以上移動する、または一定時間以上経過するまでは
 * 新しい値を反映しないようスロットリングしており、これがバッテリー消費と
 * WebSocket の通信量を抑えるための調整点になっている。
 */
export function useLiveLocation(enabled: boolean) {
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [error, setError] = useState<GeoError | null>(null);
  // 直近で採用（＝呼び出し元に反映）した位置と、その時刻を保持する。
  const lastSent = useRef<{ point: GeoPoint; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setError({ code: "unsupported", message: "このブラウザは位置情報の取得に対応していません" });
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const next: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };

        // 前回採用した位置から「十分離れた」か「十分時間が経った」場合のみ反映する。
        const prev = lastSent.current;
        const now = Date.now();
        const farEnough = !prev || haversineMeters(prev.point, next) >= LIVE_UPDATE_MIN_DISTANCE_M;
        const longEnough = !prev || now - prev.at >= LIVE_UPDATE_MIN_INTERVAL_MS;

        if (farEnough || longEnough) {
          lastSent.current = { point: next, at: now };
          setPoint(next);
          setError(null);
        }
      },
      (err) => setError(toGeoError(err)),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    // クリーンアップ: 監視を停止する。
    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled]);

  return { point, error };
}
