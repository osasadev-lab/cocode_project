// Runtime configuration, all read from NEXT_PUBLIC_* env vars so the same
// static build can point at different backends per environment without a
// rebuild-per-secret setup (there are no secrets here — see README).
//
// 実行時設定。すべて NEXT_PUBLIC_* 環境変数から読み込むことで、
// 同じ静的ビルド成果物を環境ごとに違うバックエンドへ向けられる
// （ここに秘匿情報は含まれないため、環境ごとの再ビルドは不要。詳細は README 参照）。

// required は環境変数の値を返す。未設定/空文字なら fallback を返す。
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
// NEXT_PUBLIC_* の値は、Next.js のバンドラが静的解析でインライン化できるよう、
// 動的な `process.env[name]` ではなく `process.env.NEXT_PUBLIC_X` の
// リテラル形式でアクセスする必要がある。
export const API_BASE_URL = required(process.env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8080");
export const WS_BASE_URL = required(process.env.NEXT_PUBLIC_WS_BASE_URL, "ws://localhost:8080");
export const MAP_STYLE_URL = required(
  process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  "https://demotiles.maplibre.org/style.json"
);

// How often (ms) and how far (meters) a live GPS fix must differ from the
// last one sent before it's forwarded to the server (spec §5.3: battery /
// bandwidth conscious throttling).
// ライブ GPS 位置をサーバーへ送信するまでの間隔（ms）と移動距離（m）のしきい値。
// バッテリーと通信量に配慮したスロットリング（仕様書§5.3）。
export const LIVE_UPDATE_MIN_INTERVAL_MS = 5000;
export const LIVE_UPDATE_MIN_DISTANCE_M = 15;

// localStorage に保存する際のキー名。
export const LOCAL_STORAGE_KEY = "cocode:session";
