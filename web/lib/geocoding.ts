import { MAPTILER_KEY } from "./config";

// MapTiler Geocoding API(https://docs.maptiler.com/cloud/api/geocoding/)を
// 使い、住所文字列から候補地点(緯度経度)を取得する（仕様書§10）。
export interface GeocodingResult {
  lat: number;
  lng: number;
  label: string;
}

interface MapTilerFeature {
  center: [number, number]; // [lng, lat]
  place_name: string;
}

// searchAddress: 入力文字列から候補地点を検索する。キー未設定・空文字入力
// の場合は何もせず空配列を返す。country=jpで日本国内の候補に絞る
// （cocodeは日本国内利用が前提のため）。
export async function searchAddress(query: string): Promise<GeocodingResult[]> {
  const q = query.trim();
  if (!MAPTILER_KEY || q === "") return [];
  const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?key=${MAPTILER_KEY}&language=ja&country=jp`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { features?: MapTilerFeature[] };
  return (data.features ?? []).map((f) => ({
    lat: f.center[1],
    lng: f.center[0],
    label: f.place_name,
  }));
}
