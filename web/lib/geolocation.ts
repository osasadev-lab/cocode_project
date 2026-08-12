import { useEffect, useRef, useState } from "react";
import { LIVE_UPDATE_MIN_DISTANCE_M, LIVE_UPDATE_MIN_INTERVAL_MS } from "./config";

export interface GeoPoint {
  lat: number;
  lng: number;
  accuracy: number;
}

/** One-shot current-position lookup for the "現在地を使う" button. */
export function getCurrentPosition(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("このブラウザは位置情報の取得に対応していません"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
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
 * Continuously watches the browser's GPS position (spec §5.3) and reports
 * every fix, throttled so a subsequent update is only surfaced once the
 * device has moved far enough or enough time has passed — this is the
 * knob that keeps battery and WebSocket traffic reasonable.
 */
export function useLiveLocation(enabled: boolean) {
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSent = useRef<{ point: GeoPoint; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setError("このブラウザは位置情報の取得に対応していません");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const next: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };

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
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled]);

  return { point, error };
}
