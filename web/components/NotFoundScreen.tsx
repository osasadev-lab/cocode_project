"use client";

/**
 * セッションが終了した、またはリンクが無効な場合に B が到達する全画面表示。
 * B はそもそも A のセッションに関する詳細を一切知らされていないため
 * （仕様書§8: B が持つのはトークンのみで、セッションのメタ情報は持たない）、
 * 詳しい説明ではなく意図的に単純な404ページとしている。
 */
export function NotFoundScreen() {
  return (
    <div className="cocode-center-shell">
      <div className="cocode-glass cocode-modal">
        <div className="cocode-modal-icon">🔍</div>
        <p className="cocode-modal-title">404 — ページが見つかりません</p>
        <p className="cocode-modal-body">このリンクは無効か、共有がすでに終了しています。</p>
      </div>
    </div>
  );
}
