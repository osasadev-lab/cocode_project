"use client";

import { useEffect, useState } from "react";
import { CreateForm } from "@/components/CreateForm";
import { LiveSession } from "@/components/LiveSession";
import { loadSession } from "@/lib/storage";

// Mode: この単一ページが現在どの画面を表示すべきかを表す状態。
// - loading: URL/localStorage を確認中
// - create: 待ち合わせ地点の未選択（新規セッション作成前）
// - session: セッション参加中（ライブ共有画面）
type Mode =
  | { kind: "loading" }
  | { kind: "create" }
  | { kind: "session"; sessionId: string; token: string; shareUrl?: string };

// sessionUrl は、セッション参加用の URL（?s=<id>&t=<token>）を組み立てる。
//
// cocode は静的 HTML として書き出される（next.config.js の output: "export"）ため、
// 動的な /s/[id] ルートは存在しない。代わりにこの単一ページが、URL の
// クエリ文字列から自分の役割を判断する（仕様書§3のルーティング注記, §5.1, §10-2）。
// クエリ文字列なしの素の URL は常に「待ち合わせ地点を選ぶ」画面であり、
// A・B いずれもライブ共有中は必ず `?s=<id>&t=<token>` 形式の URL を見る。
// A 自身のトークンは、招待リンク（B のトークンを含む）とは別の
// 個人用 URL を形成する。localStorage から再開したセッションは、
// 表示内容と URL が常に一致するよう replaceState でアドレスバーを書き換える。
function sessionUrl(sessionId: string, token: string): string {
  return `/?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`;
}

// Page: cocode のトップレベルページ。URL とローカル保存されたセッションから
// 現在の Mode を判定し、対応する画面（作成 or ライブ共有）を表示する。
export default function Page() {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("s");
    const t = params.get("t");
    const stored = loadSession();

    // URL にセッション情報（s, t）があれば最優先でそれを使う。
    if (s && t) {
      // 招待リンク（B のトークン）は localStorage には書き込まれないため、
      // ここで復元できるのは同じ端末で A がリロードした場合のみ。
      // しかしそれこそが重要なケースであり、A 自身の shareUrl は
      // セッション作成レスポンス以外に取得手段が無いため。
      const shareUrl = stored && stored.sessionId === s ? stored.shareUrl : undefined;
      setMode({ kind: "session", sessionId: s, token: t, shareUrl });
      return;
    }

    // URL には無いが localStorage に保存済みセッションがあれば、それを復元しURLへ反映する。
    if (stored) {
      window.history.replaceState(null, "", sessionUrl(stored.sessionId, stored.token));
      setMode({
        kind: "session",
        sessionId: stored.sessionId,
        token: stored.token,
        shareUrl: stored.shareUrl,
      });
      return;
    }

    // どちらも無ければ新規作成画面から始める。
    setMode({ kind: "create" });
  }, []);

  if (mode.kind === "loading") {
    return <div className="cocode-center-shell">読み込み中…</div>;
  }

  if (mode.kind === "create") {
    return (
      <CreateForm
        onCreated={(sessionId, token, shareUrl) => {
          window.history.replaceState(null, "", sessionUrl(sessionId, token));
          setMode({ kind: "session", sessionId, token, shareUrl });
        }}
      />
    );
  }

  return <LiveSession sessionId={mode.sessionId} token={mode.token} shareUrl={mode.shareUrl} />;
}
