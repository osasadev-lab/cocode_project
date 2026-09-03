"use client";

import { Button, Card } from "@heroui/react";
import { SearchX } from "lucide-react";

/**
 * セッションが終了した、またはリンクが無効な場合に B が到達する全画面表示。
 * B はそもそも A のセッションに関する詳細を一切知らされていないため
 * （仕様書§8: B が持つのはトークンのみで、セッションのメタ情報は持たない）、
 * 詳しい説明ではなく意図的に単純な404ページとしている。
 * トップページへ戻る導線が無く抜け出せない不具合の修正(2026-09-03、p8§11)。
 * SessionEndedScreenと同じくwindow.location.assignで直接遷移する
 * （復元済みのlocalStorage情報は書き換えず、遷移先のトップページ側の
 * 判定ロジック(§14.1.2)にそのまま委ねる）。
 */
export function NotFoundScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Content className="flex flex-col items-center gap-3 py-8 text-center">
          <SearchX className="size-9 text-muted" aria-hidden />
          <Card.Title>404 — ページが見つかりません</Card.Title>
          <Card.Description>このリンクは無効か、共有がすでに終了しています。</Card.Description>
          <Button variant="primary" fullWidth onPress={() => window.location.assign("/")}>
            トップページに戻る
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}
