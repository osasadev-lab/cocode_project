// 実行時設定。すべて NEXT_PUBLIC_* 環境変数から読み込むことで、
// 同じ静的ビルド成果物を環境ごとに違うバックエンドへ向けられる
// （ここに秘匿情報は含まれないため、環境ごとの再ビルドは不要。詳細は README 参照）。

// required は環境変数の値を返す。未設定/空文字なら fallback を返す。
function required(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

// デフォルト値はローカル開発用バックエンドと、MapLibre の無料・登録不要なデモ
// スタイルを指しており、`npm run dev` が何も準備せずそのまま動くようにしている。
// 本番ではより洗練された見た目にするため、NEXT_PUBLIC_MAP_STYLE_URL を
// MapTiler のスタイルに差し替える（仕様書§9、設定方法は README 参照）。
//
// NEXT_PUBLIC_* の値は、Next.js のバンドラが静的解析でインライン化できるよう、
// 動的な `process.env[name]` ではなく `process.env.NEXT_PUBLIC_X` の
// リテラル形式でアクセスする必要がある。
export const API_BASE_URL = required(process.env.NEXT_PUBLIC_API_BASE_URL, "http://localhost:8080");
export const WS_BASE_URL = required(process.env.NEXT_PUBLIC_WS_BASE_URL, "ws://localhost:8080");
export const MAP_STYLE_URL = required(
  process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  "https://demotiles.maplibre.org/style.json"
);
// ダーク時間帯(18:00〜4:00、仕様書§4)用のスタイル。未設定時はライトへフォールバックする。
export const MAP_STYLE_URL_DARK = required(process.env.NEXT_PUBLIC_MAP_STYLE_URL_DARK, MAP_STYLE_URL);
// MapTiler Geocoding API(住所検索、仕様書§10)呼び出し用の生キー。
// 地図スタイルURLには既にキーが埋め込まれているため、これとは別に必要になる。
export const MAPTILER_KEY = required(process.env.NEXT_PUBLIC_MAPTILER_KEY, "");

// Google AdSense(仕様書§15.1)。ホスト用・ゲスト用トップページの広告エリアに
// それぞれ1箇所ずつ設置する。パブリッシャーID未取得の間は空文字のままにし、
// `AdSlot`コンポーネント側で未設定時は広告を出さず既存のプレースホルダー
// 表示にフォールバックする(他機能に影響しない設計、フィードバック機能の
// SMTP未設定時と同じ方針)。
export const ADSENSE_CLIENT_ID = required(process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID, "");
export const ADSENSE_SLOT_ID = required(process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID, "");

// Buy Me a Coffeeのプロフィールリンク(仕様書§15、2026-08-31実装)。未設定の間は
// サイドバーに項目自体を表示しない(AdSenseと違い、審査対策で常に表示する
// 必要が無いため — リンク先が無い状態で項目だけ出すと壊れて見える)。
export const BUY_ME_A_COFFEE_URL = required(process.env.NEXT_PUBLIC_BUY_ME_A_COFFEE_URL, "");

// ライブ GPS 位置をサーバーへ送信するまでの間隔（ms）と移動距離（m）のしきい値。
// バッテリーと通信量に配慮したスロットリング（仕様書§5.3）。
export const LIVE_UPDATE_MIN_INTERVAL_MS = 5000;
export const LIVE_UPDATE_MIN_DISTANCE_M = 15;

// 地図マーカーの到着バッジ(チェックマーク)を表示する半径(m)。サーバー側の
// 到着判定(server/internal/hub/hub.go の arrivalRadiusMeters)と同じ値を使う。
// 到着は一度成立すると恒久的な事実として参加者一覧には残り続けるが
// (socket.arrivedIds)、地図マーカーのバッジは「現在この範囲内にいる間」だけ
// 表示する(2026-08-31修正: 到着後に目的地から離れてもバッジが地図上に
// 残り続け、離れた場所にいるのにバッジが付いているように見える不具合の対応)。
export const ARRIVAL_RADIUS_M = 50;

// localStorage に保存する際のキー名。
export const LOCAL_STORAGE_KEY = "cocode:session";
// ゲストの再訪検知用ID(セッションID→participantIdのマップ)を保存する
// 際のキー名。上記LOCAL_STORAGE_KEY(単一のアクティブセッション用)とは
// 別物で、「退出」操作でもクリアされない(lib/storage.ts参照)。
export const GUEST_IDENTITY_STORAGE_KEY = "cocode:guest-identities";
// 手動テーマ切り替え(システム/ライト/ダーク、2026-09-02新設)の選択を保存する
// 際のキー名。値が無い(未設定)場合は「システム」扱いとする(lib/theme.ts参照)。
export const THEME_STORAGE_KEY = "cocode:theme";
