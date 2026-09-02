import { MAPTILER_KEY } from "./config";

// 住所文字列から候補地点(緯度経度)を取得する（仕様書§10）。
//
// 2プロバイダを使い分けるハイブリッド構成にしている（2026-09-02改訂、
// p7残課題「住所検索の精度向上」の対応）:
//   1. GSI(国土地理院)の住所検索API — 丁目・番地・号までの構造化された
//      住所に強い。APIキー不要・無料。建物名・部屋番号(「メゾン寺崎201」等)
//      が末尾に付いていても、その部分は無視されて番地までの位置が正しく
//      返ってくることを実地確認済み。一方、駅名・施設名のような一般的な
//      地名検索には向かない（例:「渋谷駅」は無関係な同名地名がヒットする）。
//   2. MapTiler Geocoding API(OSMベース) — 駅名・施設名等のランドマーク
//      検索に強い一方、「東京都練馬区練馬3-22-8」のような番地レベルの住所は
//      実地検証の結果ほぼ解決できない(無関係な低relevanceの候補しか
//      返らない)ことを確認した。
//
// クエリが「番地っぽい」(数字+丁目/番地/号/ハイフン等を含む)場合はGSIを
// 優先し、そうでなければMapTilerを優先する。優先した方が0件だった場合は
// もう一方へフォールバックする(どちらか一方が苦手なパターンでも、
// 最終的に何かしら見つかる可能性を残すため)。
export interface GeocodingResult {
  lat: number;
  lng: number;
  label: string;
}

// 1回の検索で提示する候補数の上限(GSIは広い地名だと大量にヒットしうるため)。
const MAX_RESULTS = 8;

// looksLikeStructuredAddress: 「丁目/番地/号」やハイフン区切りの番地など、
// 番地レベルまで書かれた住所らしい入力かどうかを判定する簡易ヒューリスティック。
// 数字を含み、かつ住所でよく使われる区切り文字を伴う場合に true とする。
function looksLikeStructuredAddress(query: string): boolean {
  return /\d/.test(query) && /[-－ー丁目番地号]/.test(query);
}

interface GsiFeature {
  geometry: { coordinates: [number, number] }; // [lng, lat]
  properties: { title: string };
}

// searchViaGsi: 国土地理院の住所検索API(https://msearch.gsi.go.jp/address-search/)
// を呼ぶ。APIキー不要。失敗時は例外を投げず空配列を返す(呼び出し元でのフォール
// バック判断を単純にするため)。
async function searchViaGsi(query: string): Promise<GeocodingResult[]> {
  try {
    const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as GsiFeature[];
    return data.slice(0, MAX_RESULTS).map((f) => ({
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      label: f.properties.title,
    }));
  } catch {
    return [];
  }
}

interface MapTilerFeature {
  center: [number, number]; // [lng, lat]
  place_name: string;
}

// searchViaMapTiler: MapTiler Geocoding API
// (https://docs.maptiler.com/cloud/api/geocoding/)を呼ぶ。country=jpで
// 日本国内の候補に絞る(cocodeは日本国内利用が前提のため)。キー未設定の
// 場合は呼び出し元で完全にスキップされる想定。
async function searchViaMapTiler(query: string): Promise<GeocodingResult[]> {
  try {
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&language=ja&country=jp`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: MapTilerFeature[] };
    return (data.features ?? []).slice(0, MAX_RESULTS).map((f) => ({
      lat: f.center[1],
      lng: f.center[0],
      label: f.place_name,
    }));
  } catch {
    return [];
  }
}

// searchAddress: 入力文字列から候補地点を検索する。空文字入力の場合は
// 何もせず空配列を返す。
export async function searchAddress(query: string): Promise<GeocodingResult[]> {
  const q = query.trim();
  if (q === "") return [];

  const preferGsi = looksLikeStructuredAddress(q);
  const [primary, secondary] = preferGsi ? [searchViaGsi, searchViaMapTiler] : [searchViaMapTiler, searchViaGsi];

  const primaryResults = await primary(q);
  if (primaryResults.length > 0) return primaryResults;

  // MapTiler側はキー未設定だと呼んでも常に空配列になるため、
  // secondaryがMapTilerの場合はキーの有無に関わらずそのまま呼んで構わない。
  return secondary(q);
}
