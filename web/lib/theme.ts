import { THEME_STORAGE_KEY } from "./config";

// ThemeMode: 表示テーマの手動切り替え(仕様書§20.3、2026-09-02新設)。
// "system"はOS設定(prefers-color-scheme)への自動追従(従来の既定挙動)を表す。
export type ThemeMode = "system" | "light" | "dark";

// applyTheme は現在のモードから実際のライト/ダークを判定し、
// <html>のdarkクラス/data-theme属性へ反映する(app/layout.tsxのTHEME_INIT_SCRIPT
// と同じロジック — あちらは文字列内のvanilla JSのため、ここで重複させている)。
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

// loadThemeMode は保存済みの選択を読み込む(未保存/不正値なら"system")。
export function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// saveThemeMode は選択を保存し、即座に画面へ反映する。
// "system"を選んだ場合はキー自体を削除する(OS設定への追従に戻す)。
export function saveThemeMode(mode: ThemeMode): void {
  if (typeof window !== "undefined") {
    if (mode === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }
  applyTheme(mode);
}
