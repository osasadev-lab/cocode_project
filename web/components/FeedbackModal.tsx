"use client";

import { useState } from "react";
import { Button, Input, Label, Modal, TextArea, TextField } from "@heroui/react";
import { HeartHandshake } from "lucide-react";
import { ApiError, submitFeedback } from "@/lib/api";

interface FeedbackModalProps {
  onClose: () => void;
}

const MAX_MESSAGE_LENGTH = 2000;

// フィードバックフォーム(仕様書§17.1〜§17.2、2026-08-31実装)。バックエンドは
// 既に実装済み(POST /api/feedback、DB保存+開発者へのメール通知)のため、
// ここでは入力・送信・状態表示のUIのみを担う。返信を希望する場合の連絡先は
// 任意入力(メールアドレス等の形式チェックはしない — バックエンドも
// 検証しておらず、あくまで「返信が欲しい場合に書いてもらう」任意項目のため)。
export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [message, setMessage] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const trimmed = message.trim();
    if (trimmed === "") {
      setError("内容を入力してください");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await submitFeedback(trimmed, replyTo.trim() || undefined);
      setSent(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError("送信回数の上限に達しました。しばらくしてから再度お試しください。");
      } else {
        setError("送信に失敗しました。時間をおいて再度お試しください。");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="flex flex-col gap-3 text-center">
            {sent ? (
              <>
                <Modal.Icon>
                  <HeartHandshake className="size-8 text-accent" aria-hidden />
                </Modal.Icon>
                <Modal.Heading>送信しました</Modal.Heading>
                <Modal.Body>ご意見ありがとうございます。今後のcocode改善の参考にさせていただきます。</Modal.Body>
                <Modal.Footer>
                  <Button variant="primary" fullWidth onPress={onClose}>
                    閉じる
                  </Button>
                </Modal.Footer>
              </>
            ) : (
              <>
                <Modal.Heading>フィードバックを送る</Modal.Heading>
                <Modal.Body className="flex flex-col gap-3 text-left">
                  <p className="text-sm text-muted">不具合報告・ご要望など、お気軽にお送りください。</p>
                  <TextField value={message} onChange={(v) => setMessage(v.slice(0, MAX_MESSAGE_LENGTH))} isRequired>
                    <Label>
                      内容({message.length}/{MAX_MESSAGE_LENGTH})
                    </Label>
                    <TextArea rows={5} placeholder="例: 目的地変更後に地図が更新されないことがあります" />
                  </TextField>
                  <TextField value={replyTo} onChange={setReplyTo}>
                    <Label>返信先(任意)</Label>
                    <Input placeholder="返信が欲しい場合は連絡先を入力" />
                  </TextField>
                  {error && <p className="text-sm text-danger">{error}</p>}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="primary" fullWidth onPress={send} isDisabled={sending}>
                    {sending ? "送信中…" : "送信する"}
                  </Button>
                  <Button variant="outline" fullWidth onPress={onClose} isDisabled={sending}>
                    閉じる
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
