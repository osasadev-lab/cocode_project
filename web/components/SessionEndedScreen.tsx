"use client";

import { useState } from "react";
import { Button, Card } from "@heroui/react";
import { Clock, MessageCircle, PartyPopper } from "lucide-react";
import { FeedbackModal } from "./FeedbackModal";

interface SessionEndedScreenProps {
  reason: "manual" | "ttl";
}

/**
 * セッション終了後に A が到達する全画面表示（仕様書§5.5/§9）。
 * その時点で地図に表示すべきものが無いため、地図の上のモーダルではなく
 * 専用画面としている。フィードバックはここ(共有終了直後)から送れるように
 * する(仕様書§17.1、2026-08-31改訂: 汎用メニューからではなく、体験の直後の
 * このタイミングで案内する)。
 */
export function SessionEndedScreen({ reason }: SessionEndedScreenProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const title = reason === "manual" ? "共有を終了しました" : "セッションの有効期限が切れました";
  const body =
    reason === "manual"
      ? "位置共有を終了しました。もう一度待ち合わせを共有するには、新しく共有リンクを発行してください。"
      : "このセッションは作成から1時間で自動的に終了する設計です。待ち合わせが続く場合は、新しく共有リンクを発行してください。";
  const Icon = reason === "manual" ? PartyPopper : Clock;

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Content className="flex flex-col items-center gap-3 py-8 text-center">
          <Icon className="size-9 text-muted" aria-hidden />
          <Card.Title>{title}</Card.Title>
          <Card.Description>{body}</Card.Description>
          <Button variant="primary" fullWidth onPress={() => window.location.assign("/")}>
            新しく共有リンクを作成する
          </Button>
          <Button variant="outline" fullWidth onPress={() => setFeedbackOpen(true)}>
            <MessageCircle className="size-4" aria-hidden />
            フィードバックを送る
          </Button>
        </Card.Content>
      </Card>

      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}
