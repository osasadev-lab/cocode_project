// Runtime configuration, all read from NEXT_PUBLIC_* env vars so the same
// static build can point at different backends per environment without a
// rebuild-per-secret setup (there are no secrets here — see README).

function required(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

// Defaults target a local dev backend and MapLibre's free, no-signup demo
// style, so `npm run dev` works out of the box without provisioning
// anything. Swap NEXT_PUBLIC_MAP_STYLE_URL for a MapTiler style in
// production for a nicer basemap (spec §9) — see README for setup.
//
// NEXT_PUBLIC_* values must be read via a literal `process.env.NEXT_PUBLIC_X`
// property access (not a dynamic `process.env[name]`) so Next.js's bundler
// can statically find and inline them into the browser bundle.
export const API_BASE_URL = required(process.env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8080");
export const WS_BASE_URL = required(process.env.NEXT_PUBLIC_WS_BASE_URL, "ws://localhost:8080");
export const MAP_STYLE_URL = required(
  process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  "https://demotiles.maplibre.org/style.json"
);

// How often (ms) and how far (meters) a live GPS fix must differ from the
// last one sent before it's forwarded to the server (spec §5.3: battery /
// bandwidth conscious throttling).
export const LIVE_UPDATE_MIN_INTERVAL_MS = 5000;
export const LIVE_UPDATE_MIN_DISTANCE_M = 15;

export const LOCAL_STORAGE_KEY = "cocode:session";
