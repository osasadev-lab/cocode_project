"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { AlertDialog, Button, Modal } from "@heroui/react";
import { AlertTriangle, Camera, Check, Link2, RefreshCw } from "lucide-react";

interface ShareLinkModalProps {
  shareUrl: string;
  onClose: () => void;
  /** ホストのみ「リンクを再発行する」を表示する(2026-09-02新設)。 */
  isHost?: boolean;
  /** 指定時、「リンクを再発行する」ボタンを表示する。ホスト自身のURLを
   * 誤って共有してしまった等、トークン漏えいが疑われる場合の安全弁
   * (以前のリンクはすべて無効になる)。 */
  onRegenerate?: () => void;
  regenerating?: boolean;
  regenerateError?: string | null;
}

// リンク共有ボタン押下で開くモーダル(2026-08-31新設)。ホスト・ゲストいずれも
// 常時招待できるようにする(仕様書§14.4)。ゲストが共有する場合も、URLに
// 含まれるトークンは全ゲスト共通の招待トークンのため、そのまま再共有して問題ない。
// QRコード(仕様書§12.1-②)もここから表示できる — セッション作成直後の専用
// 案内画面は廃止し、このモーダル1つに集約した(2026-08-31改訂)。
export function ShareLinkModal({ shareUrl, onClose, isHost, onRegenerate, regenerating, regenerateError }: ShareLinkModalProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // コピー前の注意喚起(2026-09-02改訂): 従来はwindow.alert()で表示していたが、
  // ブラウザ標準のブロッキングダイアログでUIと見た目が揃わないため、
  // HeroUIのAlertDialogに置き換えた。
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  // confirmingRegenerate(2026-09-02新設): 「リンクを再発行する」は以前の
  // リンクを即座に無効化する不可逆な操作のため、他の破壊的操作(共有終了等)
  // と同じくAlertDialogで確認を挟む。
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(shareUrl, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shareUrl]);

  async function copy() {
    setConfirmingCopy(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard APIが使えない場合(非セキュアコンテキスト等)は、表示中のURLを手動選択してコピーしてもらう。
    }
  }

  return (
    <>
      <Modal isOpen onOpenChange={(open) => !open && onClose()}>
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog className="flex flex-col items-center gap-3.5 p-7 text-center">
              <Modal.Icon>
                <Link2 />
              </Modal.Icon>
              <Modal.Heading className="text-lg font-bold">友達を招待</Modal.Heading>
              <div className="w-full truncate rounded-(--radius-field) bg-surface-secondary px-3 py-2.5 font-mono text-xs text-muted" title={shareUrl}>
                {shareUrl}
              </div>
              <Button variant="primary" fullWidth onPress={() => setConfirmingCopy(true)}>
                {copied && <Check className="size-4" />}
                {copied ? "コピーしました" : "リンクをコピー"}
              </Button>
              <Button variant="outline" fullWidth onPress={() => setShowQr((v) => !v)} isDisabled={!qrDataUrl}>
                {!showQr && <Camera className="size-4" />}
                {showQr ? "QRコードを隠す" : "QRコードを表示"}
              </Button>
              {showQr && qrDataUrl && <img src={qrDataUrl} alt="共有URLのQRコード" className="mt-2 size-45 self-center rounded-(--radius-field)" />}
              {isHost && onRegenerate && (
                <>
                  <Button
                    variant="outline"
                    fullWidth
                    onPress={() => setConfirmingRegenerate(true)}
                    isDisabled={regenerating}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    リンクを再発行する
                  </Button>
                  <p className="-mt-1.5 text-xs leading-relaxed text-muted">
                    このURLを誤って共有してしまった場合など、無効化したいときに使います。以前のリンクは使えなくなります。
                  </p>
                  {regenerateError && <p className="text-sm text-danger">{regenerateError}</p>}
                </>
              )}
              <Button variant="outline" fullWidth onPress={onClose}>
                閉じる
              </Button>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog isOpen={confirmingCopy} onOpenChange={(open) => !open && setConfirmingCopy(false)}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container size="sm">
            <AlertDialog.Dialog className="flex flex-col items-center gap-3.5 p-7 text-center">
              <AlertDialog.Icon status="warning">
                <AlertTriangle />
              </AlertDialog.Icon>
              <AlertDialog.Heading className="text-lg font-bold">リンクの共有について</AlertDialog.Heading>
              <AlertDialog.Body className="text-sm leading-relaxed text-muted">
                共有リンクを知っている人は誰でも参加者全員の位置情報を見ることができます。信頼できる相手にのみ送ってください。
              </AlertDialog.Body>
              <AlertDialog.Footer className="flex w-full flex-col gap-2">
                <Button variant="primary" fullWidth onPress={copy}>
                  コピーする
                </Button>
                <Button variant="outline" fullWidth onPress={() => setConfirmingCopy(false)}>
                  キャンセル
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>

      {isHost && onRegenerate && (
        <AlertDialog isOpen={confirmingRegenerate} onOpenChange={(open) => !open && setConfirmingRegenerate(false)}>
          <AlertDialog.Backdrop>
            <AlertDialog.Container size="sm">
              <AlertDialog.Dialog className="flex flex-col items-center gap-3.5 p-7 text-center">
                <AlertDialog.Icon status="warning">
                  <AlertTriangle />
                </AlertDialog.Icon>
                <AlertDialog.Heading className="text-lg font-bold">リンクを再発行しますか？</AlertDialog.Heading>
                <AlertDialog.Body className="text-sm leading-relaxed text-muted">
                  この操作を行うと、これまでに発行した招待リンク・QRコード、ホスト自身の参加用URLはすべて無効になります。参加者を招待し直したい場合は、再発行後の新しいリンクを送り直してください。
                </AlertDialog.Body>
                <AlertDialog.Footer className="flex w-full flex-col gap-2">
                  <Button
                    variant="primary"
                    fullWidth
                    onPress={() => {
                      setConfirmingRegenerate(false);
                      onRegenerate();
                    }}
                    isDisabled={regenerating}
                  >
                    {regenerating ? "再発行中…" : "再発行する"}
                  </Button>
                  <Button variant="outline" fullWidth onPress={() => setConfirmingRegenerate(false)}>
                    キャンセル
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      )}
    </>
  );
}
