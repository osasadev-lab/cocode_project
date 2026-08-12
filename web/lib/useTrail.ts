import { useEffect, useRef, useState } from "react";
import type { LocationState, TrailPoint } from "./types";

/**
 * Accumulates a location stream into a growing polyline for the map (spec
 * §5.4). This is intentionally client-side-only and never sent to the
 * server (spec §5.4/§10-5) — it resets whenever the page reloads.
 */
export function useTrail(current: LocationState | null): TrailPoint[] {
  const pointsRef = useRef<TrailPoint[]>([]);
  const lastKeyRef = useRef<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!current) return;
    const key = `${current.lat},${current.lng}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    pointsRef.current = [...pointsRef.current, { lat: current.lat, lng: current.lng }];
    bump((n) => n + 1);
  }, [current]);

  return pointsRef.current;
}
