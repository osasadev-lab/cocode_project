// cocode の自前Service Worker（仕様書§18.3）。next-pwa等の重量級ライブラリは
// 使わず、最小限のアプリシェルキャッシュのみを行う。
//
// キャッシュ対象はアプリシェル(HTML/CSS/JS/ロゴ・アイコン画像)のみ。
// 地図タイル(MapTiler)・OSRM・NAVITIME/ジョルダン(電車ETA)・WebSocket通信は
// 対象外とする(位置情報・リアルタイム性が要求される画面でキャッシュすると
// 誤情報を表示するリスクがあるため)。
//
// キャッシュ名はビルドごとにバージョニングし、activate時に旧キャッシュを破棄する。
const CACHE_NAME = "cocode-shell-v1";
const SHELL_ASSETS = ["/", "/brand/logo.png", "/brand/icon-192.png", "/brand/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク必須の外部API呼び出し(REST/WS)や地図タイルはこのService Workerの
// 対象外とし、同一オリジンのナビゲーション・静的アセットのみcache-firstで扱う。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 外部API・タイルはスルー
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => {
          // オフライン時、キャッシュにも無ければブラウザの標準オフラインページに任せる
          // (セッション作成等ネットワーク必須の操作は、呼び出し元のUIが明示的に
          // 案内する。仕様書§18.3)。
          return caches.match("/");
        });
    })
  );
});
