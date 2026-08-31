import { MAP_STYLE_URL, MAP_STYLE_URL_DARK } from "./config";

// isDarkHours: 日本時間・端末ローカル時刻で18:00〜翌4:00ならtrue（仕様書§4）。
// OSのprefers-color-schemeには連動しない（v0.4から意図的に変更した点）。
export function isDarkHours(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= 18 || h < 4;
}

// currentMapStyleUrl: 現在時刻に応じたGSI地図スタイルURLを返す。
export function currentMapStyleUrl(now: Date = new Date()): string {
  return isDarkHours(now) ? MAP_STYLE_URL_DARK : MAP_STYLE_URL;
}
