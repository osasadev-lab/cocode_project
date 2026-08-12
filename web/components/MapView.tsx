"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type LngLatLike } from "maplibre-gl";
import { MAP_STYLE_URL } from "@/lib/config";
import type { LocationState, TrailPoint } from "@/lib/types";

interface MapViewProps {
  target: LocationState | null;
  liveA: LocationState | null;
  liveB: LocationState | null;
  trailA: TrailPoint[];
  trailB: TrailPoint[];
  /** When true, tapping the map reports the coordinate via onPickTarget
   * instead of just panning (used while A is choosing the meeting point). */
  pickingTarget?: boolean;
  onPickTarget?: (lat: number, lng: number) => void;
}

const SOURCE_TRAIL_A = "cocode-trail-a";
const SOURCE_TRAIL_B = "cocode-trail-b";

function emptyLine(): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
}

function lineFromTrail(trail: TrailPoint[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: trail.map((p) => [p.lng, p.lat]) },
  };
}

export function MapView({
  target,
  liveA,
  liveB,
  trailA,
  trailB,
  pickingTarget,
  onPickTarget,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveAMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveBMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hasFitRef = useRef(false);
  const onPickTargetRef = useRef(onPickTarget);
  onPickTargetRef.current = onPickTarget;

  // Map instance: created once and torn down on unmount.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [139.767, 35.681],
      zoom: 12,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    map.on("load", () => {
      map.addSource(SOURCE_TRAIL_A, { type: "geojson", data: emptyLine() });
      map.addSource(SOURCE_TRAIL_B, { type: "geojson", data: emptyLine() });
      map.addLayer({
        id: "cocode-trail-a-line",
        type: "line",
        source: SOURCE_TRAIL_A,
        paint: { "line-color": "#3b82f6", "line-width": 3, "line-opacity": 0.55 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addLayer({
        id: "cocode-trail-b-line",
        type: "line",
        source: SOURCE_TRAIL_B,
        paint: { "line-color": "#f97316", "line-width": 3, "line-opacity": 0.55 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      readyRef.current = true;
    });

    map.on("click", (e) => {
      onPickTargetRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function maybeFitBounds(map: maplibregl.Map) {
    if (hasFitRef.current) return;
    const points: LngLatLike[] = [];
    if (target) points.push([target.lng, target.lat]);
    if (liveA) points.push([liveA.lng, liveA.lat]);
    if (liveB) points.push([liveB.lng, liveB.lat]);
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !target) return;
    if (!targetMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "cocode-marker cocode-marker-target";
      el.textContent = "🚩";
      targetMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" });
    }
    targetMarkerRef.current.setLngLat([target.lng, target.lat]).addTo(map);
    maybeFitBounds(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (liveA) {
      if (!liveAMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "cocode-marker cocode-marker-live cocode-marker-a";
        liveAMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" });
      }
      liveAMarkerRef.current.setLngLat([liveA.lng, liveA.lat]).addTo(map);
      maybeFitBounds(map);
    }
    if (readyRef.current) {
      const src = map.getSource(SOURCE_TRAIL_A) as maplibregl.GeoJSONSource | undefined;
      src?.setData(lineFromTrail(trailA));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveA, trailA]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (liveB) {
      if (!liveBMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "cocode-marker cocode-marker-live cocode-marker-b";
        liveBMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" });
      }
      liveBMarkerRef.current.setLngLat([liveB.lng, liveB.lat]).addTo(map);
      maybeFitBounds(map);
    }
    if (readyRef.current) {
      const src = map.getSource(SOURCE_TRAIL_B) as maplibregl.GeoJSONSource | undefined;
      src?.setData(lineFromTrail(trailB));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveB, trailB]);

  return (
    <div ref={containerRef} className={`cocode-map${pickingTarget ? " cocode-map-picking" : ""}`} />
  );
}
