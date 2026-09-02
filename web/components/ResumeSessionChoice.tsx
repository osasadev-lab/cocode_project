"use client";

import { useState } from "react";
import { Button, Card } from "@heroui/react";
import { CircleStop } from "lucide-react";
import { ApiError, endSession } from "@/lib/api";
import { clearSession, type StoredSession } from "@/lib/storage";

interface ResumeSessionChoiceProps {
  stored: StoredSession;
  /** 「共有中の画面を表示する」: 保存済みセッションへそのまま復帰する。 */
  onResume: () => void;
  /** 停止(・新規開始)が完了した後の遷移先を選べるようにする。 */
  onStopped: (next: "landing" | "create") => void;
}

type PendingAction = "stopAndNew" | "stop" | null;

// ホスト・ゲストいずれも、共有を開始/参加した状態でトップページ(素の"/")へ
// アクセスした際に表示する選択画面(2026-08-31新設)。
//
// これまでは黙って直接ライブマップへ自動復帰していたが、ユーザーが
// 「今の共有を続ける」のか「一旦やめて別のことをしたい」のかを選べず、
// トップページ自体を見る手段も無かった。この画面を挟むことで、
// 3つの選択肢(継続/停止して新規開始/停止のみ)を明示的に提示する。
//
// ホストの「停止」はPOST /sessions/:id/end(全員終了、仕様書§5.6)を伴うが、
// ゲストの「停止」はこの画面時点ではまだWebSocket接続が無いため、
// ローカルの保存情報を消すだけの「退出」として扱う(他の参加者の共有は
// 継続する、既存のホスト/ゲスト権限分離の考え方を踏襲)。
export function ResumeSessionChoice({ stored, onResume, onStopped }: ResumeSessionChoiceProps) {
  const [confirming, setConfirming] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isHost = stored.role === "host";

  async function doStop(next: "landing" | "create") {
    setWorking(true);
    setError(null);
    try {
      if (isHost) {
        // ホストの停止は全参加者を終了させる(§5.6)。既に失効/終了済みの場合の
        // 404はエラー扱いにしない(結果的にゴールは同じ「セッションが無い」状態のため)。
        try {
          await endSession(stored.sessionId, stored.token);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      // ゲストの停止はREST呼び出し不要(§5.6の権限分離。まだWS接続前のため
      // 退出通知も発生しない、ローカル状態を消すのみ)。
      clearSession();
      onStopped(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "停止に失敗しました。時間をおいて再度お試しください。");
      setWorking(false);
    }
  }

  if (confirming) {
    const next = confirming === "stopAndNew" ? "create" : "landing";
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <Card.Content className="flex flex-col items-center gap-3 py-8 text-center">
            <CircleStop className="size-9 text-muted" aria-hidden />
            <Card.Title>{confirming === "stopAndNew" ? "共有を停止して、新しい共有を始めますか?" : "共有を停止しますか?"}</Card.Title>
            <Card.Description>
              {isHost
                ? "終了すると、参加者全員との位置共有がすぐに終わります。この操作は取り消せません。"
                : "あなたはこの共有から退出します。他の参加者の共有はそのまま継続されます。"}
            </Card.Description>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button variant="primary" fullWidth onPress={() => doStop(next)} isDisabled={working}>
              {working ? "処理中…" : confirming === "stopAndNew" ? "停止して新しく始める" : "停止する"}
            </Button>
            <Button
              variant="outline"
              fullWidth
              onPress={() => {
                setConfirming(null);
                setError(null);
              }}
              isDisabled={working}
            >
              キャンセル
            </Button>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Content className="flex flex-col gap-3 py-8">
          <div className="flex items-center gap-2 text-lg font-bold">
            <span className="size-2.5 rounded-full bg-accent" aria-hidden />
            cocode
          </div>
          <Card.Description>
            {isHost ? "現在、位置共有セッションを開始しています。" : "現在、位置共有セッションに参加しています。"}
          </Card.Description>

          <Button variant="primary" fullWidth onPress={onResume}>
            共有中の画面を表示する
          </Button>
          <Button variant="outline" fullWidth onPress={() => setConfirming("stopAndNew")}>
            共有を停止して新しい共有を始める
          </Button>
          <Button variant="outline" fullWidth onPress={() => setConfirming("stop")}>
            共有を停止する
          </Button>
          {!isHost && (
            <p className="text-xs text-muted">「停止」はあなた自身の参加のみを終了します。他の参加者の共有には影響しません。</p>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
