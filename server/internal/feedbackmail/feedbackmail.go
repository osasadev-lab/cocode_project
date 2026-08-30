// Package feedbackmail はフィードバック投稿を、コミット後にベストエフォートで
// osasadev@gmail.com宛にメール通知する（仕様書§17.2）。
// aibo_pj/server/internal/feedbackmail と同じ設計(Gmail SMTPリレー、新規の
// 外部サービス契約なし)を踏襲する。差分は、aiboのSenderName/SenderEmail/
// WorkspaceID/PagePathに対し、cocodeは認証もワークスペースも無いため
// ReplyTo(任意入力のメールアドレス文字列)/Context(画面名)に置き換えている点のみ。
package feedbackmail

import (
	"encoding/base64"
	"fmt"
	"log"
	"mime"
	"net/smtp"
	"strings"
	"time"
)

// Config はSMTP接続情報一式。Hostが空の場合はConfigured()がfalseを返し、
// Async()は何もせずスキップする（未設定でもフィードバック自体のDB保存は成功させるため）。
type Config struct {
	Host        string
	Port        string
	Username    string
	Password    string
	NotifyEmail string
}

// Configured はメール送信に必要な設定が揃っているかどうか。
func (c Config) Configured() bool {
	return c.Host != "" && c.Username != "" && c.Password != "" && c.NotifyEmail != ""
}

// Item は1件のフィードバック投稿。
type Item struct {
	Message   string
	ReplyTo   string // 任意。入力されていれば本文とReply-Toヘッダーに設定する
	Context   string // 送信時の画面(例: "host_entry"/"guest_entry"/"session_ended")
	CreatedAt time.Time
}

// Async はitemをgoroutine内でベストエフォート送信する（呼び出し元はDBコミット後に呼ぶこと）。
// 送信失敗はログ出力のみでエラーを呼び出し元に返さない（feedbacksテーブルへの保存は
// 既に成功しているため、UI上は送信成功として扱う）。
func Async(cfg Config, item Item) {
	if !cfg.Configured() {
		log.Printf("feedbackmail: SMTP not configured, skipping notification email")
		return
	}
	go func() {
		if err := send(cfg, item); err != nil {
			log.Printf("feedbackmail: failed to send notification: %v", err)
			return
		}
		log.Printf("feedbackmail: notification email sent to %s", cfg.NotifyEmail)
	}()
}

func send(cfg Config, item Item) error {
	addr := fmt.Sprintf("%s:%s", cfg.Host, cfg.Port)
	auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)

	// 件名に日本語を含むため、生のUTF-8バイト列をそのままヘッダーに置くと
	// 一部のメールクライアント/中継サーバーで文字化けする。RFC 2047に従い
	// mime.QEncoding等でエンコードする。
	subject := mime.QEncoding.Encode("UTF-8", "[cocode] フィードバックが届きました")
	// base64はASCII文字のみで転送されるため、経路の8bit対応状況に依存せず
	// 確実に届く（RFC 2045、76文字ごとに改行が必要）。
	body := encodeBase64Body(buildBody(item))

	headers := []string{
		"From: " + cfg.Username,
		"To: " + cfg.NotifyEmail,
	}
	if item.ReplyTo != "" {
		headers = append(headers, "Reply-To: "+item.ReplyTo)
	}
	headers = append(headers,
		"Subject: "+subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
	)
	msg := strings.Join(headers, "\r\n") + "\r\n\r\n" + body

	return smtp.SendMail(addr, auth, cfg.Username, []string{cfg.NotifyEmail}, []byte(msg))
}

// encodeBase64Body はRFC 2045に従い、base64文字列を76文字ごとにCRLFで折り返す。
func encodeBase64Body(s string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(s))
	var sb strings.Builder
	for i := 0; i < len(encoded); i += 76 {
		end := min(i+76, len(encoded))
		sb.WriteString(encoded[i:end])
		sb.WriteString("\r\n")
	}
	return sb.String()
}

func buildBody(item Item) string {
	replyTo := item.ReplyTo
	if replyTo == "" {
		replyTo = "（返信不要）"
	}
	context := item.Context
	if context == "" {
		context = "（不明）"
	}
	return fmt.Sprintf(
		"送信日時: %s\n画面: %s\n返信先: %s\n\n%s\n",
		item.CreatedAt.Format("2006-01-02 15:04:05"),
		context, replyTo, item.Message,
	)
}
