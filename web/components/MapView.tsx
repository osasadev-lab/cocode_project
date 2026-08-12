"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type LngLatLike } from "maplibre-gl";
import { MAP_STYLE_URL } from "@/lib/config";
import { fetchWalkingRoute } from "@/lib/routing";
import type { LocationState } from "@/lib/types";

interface MapViewProps {
  target: LocationState | null;
  liveA: LocationState | null;
  liveB: LocationState | null;
  /** When true, tapping the map reports the coordinate via onPickTarget
   * instead of just panning (used while A is choosing the meeting point). */
  pickingTarget?: boolean;
  onPickTarget?: (lat: number, lng: number) => void;
}

const SOURCE_ROUTE_A = "cocode-route-a";
const SOURCE_ROUTE_B = "cocode-route-b";

function emptyLine(): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
}

function lineFromCoords(coords: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
}

// De-dupes walking-route requests for one participant's line: skips
// re-fetching when neither endpoint moved, and cancels/ignores a
// still-in-flight request when a newer one supersedes it (fetch order isn't
// guaranteed to match response order). No debounce — GPS updates are
// already throttled upstream (LIVE_UPDATE_MIN_DISTANCE_M/MS).
function createRouteUpdater(setLine: (coords: [number, number][]) => void) {
  let lastKey = "";
  let requestId = 0;
  let abortController: AbortController | null = null;

  return function update(from: LocationState | null, to: LocationState | null) {
    if (!from || !to) {
      lastKey = "";
      abortController?.abort();
      setLine([]);
      return;
    }
    const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
    if (key === lastKey) return;
    lastKey = key;

    const thisRequestId = ++requestId;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    fetchWalkingRoute(from, to, controller.signal).then((coords) => {
      if (thisRequestId !== requestId) return; // superseded — drop this result
      if (coords) setLine(coords);
    });
  };
}

export function MapView({ target, liveA, liveB, pickingTarget, onPickTarget }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveAMarkerRef = useRef<maplibregl.Marker | null>(null);
  const liveBMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hasFitRef = useRef(false);
  const onPickTargetRef = useRef(onPickTarget);
  onPickTargetRef.current = onPickTarget;
  const updateRouteARef = useRef<ReturnType<typeof createRouteUpdater> | null>(null);
  const updateRouteBRef = useRef<ReturnType<typeof createRouteUpdater> | null>(null);
  // Tracks the latest props so route-layer setup (which may be delayed —
  // see below) can immediately fetch with whatever's already known, since
  // the props effect further down may have already run and no-op'd while
  // updateRouteARef/B were still null.
  const latestPropsRef = useRef({ target, liveA, liveB });
  latestPropsRef.current = { target, liveA, liveB };

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

    // Retries on "styledata" instead of waiting for "load": this MapTiler
    // style never fires "load" (it references at least one sprite icon,
    // "office", that 404s — MapLibre's isStyleLoaded() seems to stay false
    // forever because of it, even though the style is otherwise fully
    // usable), but calling addSource too early throws, so poll readiness
    // via the exception instead of a boolean check.
    function setUpRouteLayers() {
      try {
        map.addSource(SOURCE_ROUTE_A, { type: "geojson", data: emptyLine() });
        map.addSource(SOURCE_ROUTE_B, { type: "geojson", data: emptyLine() });
      } catch {
        return false;
      }
      // Dashed to read as a route hint rather than an authoritative path —
      // it's a walking route from a free, best-effort routing service.
      map.addLayer({
        id: "cocode-route-a-line",
        type: "line",
        source: SOURCE_ROUTE_A,
        paint: { "line-color": "#3b82f6", "line-width": 3, "line-opacity": 0.65, "line-dasharray": [2, 2] },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addLayer({
        id: "cocode-route-b-line",
        type: "line",
        source: SOURCE_ROUTE_B,
        paint: { "line-color": "#f97316", "line-width": 3, "line-opacity": 0.65, "line-dasharray": [2, 2] },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      updateRouteARef.current = createRouteUpdater((coords) => {
        (map.getSource(SOURCE_ROUTE_A) as maplibregl.GeoJSONSource | undefined)?.setData(lineFromCoords(coords));
      });
      updateRouteBRef.current = createRouteUpdater((coords) => {
        (map.getSource(SOURCE_ROUTE_B) as maplibregl.GeoJSONSource | undefined)?.setData(lineFromCoords(coords));
      });
      const { target: t, liveA: a, liveB: b } = latestPropsRef.current;
      updateRouteARef.current(a, t);
      updateRouteBRef.current(b, t);
      return true;
    }
    if (!setUpRouteLayers()) {
      const onStyleData = () => {
        if (setUpRouteLayers()) map.off("styledata", onStyleData);
      };
      map.on("styledata", onStyleData);
    }

    map.on("click", (e) => {
      onPickTargetRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      updateRouteARef.current = null;
      updateRouteBRef.current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveA]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveB]);

  // Walking route from each participant's live position to the meeting
  // point (spec update: replaces the old movement-trail lines). v1 is
  // walking-only; a later version is expected to add driving/transit as a
  // user-chosen profile.
  useEffect(() => {
    updateRouteARef.current?.(liveA, target);
    updateRouteBRef.current?.(liveB, target);
  }, [liveA, liveB, target]);

  return (
    <div ref={containerRef} className={`cocode-map${pickingTarget ? " cocode-map-picking" : ""}`} />
  );
}
