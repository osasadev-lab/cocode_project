"use client";

/**
 * B's full-screen destination once the session ends or the link is
 * otherwise invalid — deliberately a plain not-found page rather than an
 * explanation, since B was never given any details about A's session to
 * begin with (spec §8: B only ever holds a token, not session metadata).
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
