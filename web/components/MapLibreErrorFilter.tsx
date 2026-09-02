"use client";

import { useEffect } from "react";

// MapLibre GL JS(現行バージョン^4.7.1)には、地図インスタンスの破棄
// (MapView.tsxのuseEffectクリーンアップ、map.remove())時に、その時点で
// 読み込み中だったタイル等のリクエストを内部でAbortControllerを使って
// 中断する際、その中断が(呼び出し元のコードからは捕捉できない)Promise拒否
// として発生してしまう既知の挙動がある(2026-09-02発見。MapLibreの後継
// バージョン(v6.1.0)ではタイル読み込み中の中断まわりの類似の競合状態を
// 修正しているが、メジャーバージョンを跨ぐアップグレードが必要なため、
// ここでは症状をピンポイントに抑止するに留める)。
//
// メッセージ文言は発生する内部コードパスによって2通り確認している
// (どちらも同じ「地図破棄時にタイル取得が中断された」という無害な事象):
// 「signal is aborted without reason」(AbortSignalの既定reason)、
// 「The user aborted a request.」(fetch自体のAbort時の既定文言)。
//
// 発生条件の例: 共有中のゲストが招待リンクの再発行(§5.8)で退出させられる、
// または退出済みのゲストが再訪識別IDのまま同じ招待リンクを開いて参加に
// 失敗する(§14.2)等で、画面がライブ地図から404/ゲスト用トップページへ
// 切り替わり、地図コンポーネントが破棄される瞬間。地図の破棄自体・アプリの
// 動作には一切影響がない(タイルの取得を中断できているという意味では
// 正常に完了している)ため、Next.jsの開発用エラーオーバーレイにのみ
// 表示され、実害はない。
//
// 抑止は2段構え: (1) unhandledrejectionイベント(未処理のPromise拒否として
// ブラウザに直接届く経路)、(2) console.error(Next.jsの開発用オーバーレイが
// 内部でこのメッセージを検知しconsole.error経由で再ログしている経路 —
// 実際に確認したところ、こちらの経路で観測されるケースがあった)。
// 両方とも、このピンポイントな文言に一致する場合のみ抑止し、それ以外の
// エラーには一切手を加えない。
const BENIGN_MAPLIBRE_ABORT_MESSAGES = ["signal is aborted without reason", "The user aborted a request."];

function isBenignMapLibreAbortText(text: string): boolean {
  return text.includes("AbortError") && BENIGN_MAPLIBRE_ABORT_MESSAGES.some((m) => text.includes(m));
}

function reasonToText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

export function MapLibreErrorFilter() {
  useEffect(() => {
    function onUnhandledRejection(event: PromiseRejectionEvent) {
      if (isBenignMapLibreAbortText(reasonToText(event.reason))) {
        event.preventDefault();
      }
    }
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ");
      if (isBenignMapLibreAbortText(text)) return;
      originalConsoleError.apply(console, args);
    };

    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      console.error = originalConsoleError;
    };
  }, []);

  return null;
}
