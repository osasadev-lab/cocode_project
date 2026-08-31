"use client";

import { useState } from "react";
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
    <div className="cocode-modal-backdrop" onClick={onClose}>
      <div className="cocode-glass cocode-modal" onClick={(e) => e.stopPropagation()}>
        {sent ? (
          <>
            <div className="cocode-modal-icon">🙏</div>
            <p className="cocode-modal-title">送信しました</p>
            <p className="cocode-modal-body">ご意見ありがとうございます。今後のcocode改善の参考にさせていただきます。</p>
            <button className="cocode-btn cocode-btn-primary" onClick={onClose}>
              閉じる
            </button>
          </>
        ) : (
          <>
            <p className="cocode-modal-title">フィードバックを送る</p>
            <p className="cocode-modal-body">不具合報告・ご要望など、お気軽にお送りください。</p>
            <label className="cocode-hint" htmlFor="cocode-feedback-message">
              内容({message.length}/{MAX_MESSAGE_LENGTH})
            </label>
            <textarea
              id="cocode-feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              placeholder="例: 目的地変更後に地図が更新されないことがあります"
              className="cocode-text-input cocode-feedback-textarea"
              rows={5}
            />
            <label className="cocode-hint" htmlFor="cocode-feedback-replyto">
              返信先(任意)
            </label>
            <input
              id="cocode-feedback-replyto"
              type="text"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="返信が欲しい場合は連絡先を入力"
              className="cocode-text-input"
            />
            {error && <p className="cocode-error">{error}</p>}
            <button className="cocode-btn cocode-btn-primary" onClick={send} disabled={sending}>
              {sending ? "送信中…" : "送信する"}
            </button>
            <button className="cocode-btn cocode-btn-secondary" onClick={onClose} disabled={sending}>
              閉じる
            </button>
          </>
        )}
      </div>
    </div>
  );
}
