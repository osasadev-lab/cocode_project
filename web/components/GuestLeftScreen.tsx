"use client";

import { useState } from "react";
import { Button, Card } from "@heroui/react";
import { DoorOpen, MessageCircle } from "lucide-react";
import { AdSlot } from "./AdSlot";
import { FeedbackModal } from "./FeedbackModal";

interface GuestLeftScreenProps {
  onBackToTop: () => void;
}

// ゲストが「退出する」を確定した際に到達する画面(2026-08-31新設)。
// 他の参加者の共有はそのまま継続されるため、ホストのSessionEndedScreenとは
// 別に用意する。フィードバックはここ(退出直後)から送れるようにする
// (仕様書§17.1、2026-08-31改訂: 汎用メニューからではなく、体験の直後の
// このタイミングで案内する)。
export function GuestLeftScreen({ onBackToTop }: GuestLeftScreenProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Content className="flex flex-col items-center gap-3 py-8 text-center">
          <DoorOpen className="size-9 text-muted" aria-hidden />
          <Card.Title>退出しました</Card.Title>
          <Card.Description>位置共有から退出しました。他の参加者の共有はそのまま継続されています。</Card.Description>
          <Button variant="primary" fullWidth onPress={onBackToTop}>
            トップ画面に戻る
          </Button>
          <Button variant="outline" fullWidth onPress={() => setFeedbackOpen(true)}>
            <MessageCircle className="size-4" aria-hidden />
            フィードバックを送る
          </Button>
          <AdSlot />
        </Card.Content>
      </Card>

      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}
