import type { LocationState } from "./types";

// OSRM's public demo server: free, no API key, but explicitly not meant for
// production traffic (no uptime/rate-limit guarantees) — matches this
// project's existing tolerance for free-tier map services (see
// NEXT_PUBLIC_MAP_STYLE_URL). Swap this base URL for a self-hosted or paid
// OSRM/ORS instance if reliability becomes an issue.
//
// v1 only requests the walking profile; a v2 iteration is expected to let
// users pick driving/transit too, at which point `profile` below should
// become a parameter instead of a hardcoded literal.
const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1";

/**
 * Fetches a walking route as a sequence of [lng, lat] points, or null if no
 * route could be found (network failure, no path between the two points,
 * demo server unavailable, etc.) — callers should treat null as "don't draw
 * a line" rather than an error to surface to the user, since this is a
 * best-effort hint, not core functionality.
 */
export async function fetchWalkingRoute(
  from: LocationState,
  to: LocationState,
  signal?: AbortSignal
): Promise<[number, number][] | null> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${OSRM_BASE_URL}/foot/${coords}?overview=full&geometries=geojson`;
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
