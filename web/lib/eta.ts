// formatEta: 所要時間(秒)を「約12分」「約1時間30分」のように整形する。
// 移動手段選択UI(ホスト作成時・ゲスト参加時・フッターの変更)で共通して使う。
export function formatEta(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `約${minutes}分`;
  return `約${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
