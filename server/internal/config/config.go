package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config は環境変数から読み込んだ実行時設定をまとめて保持する構造体。
type Config struct {
	Port          string
	DatabaseURL   string
	PublicBaseURL string // base URL the frontend uses to build share links, e.g. https://cocode.example.com
	SessionTTL    time.Duration
	RateLimitRPM  int // POST /api/sessions requests allowed per IP per minute

	// 電車ETA(仕様書§7.1)。GoogleRoutesAPIKeyが空でも起動でき、その場合は
	// POST /api/eta/transit が503を返すだけで他機能に影響しない。
	GoogleRoutesAPIKey  string
	TransitRateLimitRPM int // POST /api/eta/transit requests allowed per IP per minute

	// フィードバック通知メール(仕様書§17.2)。SMTPHostが空ならfeedbackmail.Asyncは
	// 何もせずスキップする(aiboのfeedbackmailパターンを踏襲)。
	SMTPHost            string
	SMTPPort            string
	SMTPUsername        string
	SMTPPassword        string
	FeedbackNotifyEmail string
}

// Load は環境変数から設定値を読み込み、ローカル開発用の妥当なデフォルト値を適用する。
// DATABASE_URL のみ必須で、未設定の場合はエラーを返す。
func Load() (*Config, error) {
	// DATABASE_URL は唯一の必須項目。無ければ即座にエラーとする。
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	// 残りの項目は未設定でも動くよう、それぞれデフォルト値を用意する。
	port := envOrDefault("PORT", "8080")
	publicBaseURL := envOrDefault("PUBLIC_BASE_URL", "http://localhost:3000")
	ttlMinutes := envIntOrDefault("SESSION_TTL_MINUTES", 60)
	rateLimit := envIntOrDefault("RATE_LIMIT_RPM", 5)
	transitRateLimit := envIntOrDefault("TRANSIT_RATE_LIMIT_RPM", 10)

	return &Config{
		Port:          port,
		DatabaseURL:   dbURL,
		PublicBaseURL: publicBaseURL,
		SessionTTL:    time.Duration(ttlMinutes) * time.Minute,
		RateLimitRPM:  rateLimit,

		GoogleRoutesAPIKey:  os.Getenv("GOOGLE_ROUTES_API_KEY"),
		TransitRateLimitRPM: transitRateLimit,

		SMTPHost:            os.Getenv("SMTP_HOST"),
		SMTPPort:            envOrDefault("SMTP_PORT", "587"),
		SMTPUsername:        os.Getenv("SMTP_USERNAME"),
		SMTPPassword:        os.Getenv("SMTP_PASSWORD"),
		FeedbackNotifyEmail: os.Getenv("FEEDBACK_NOTIFY_EMAIL"),
	}, nil
}

// envOrDefault は環境変数の値を返す。未設定（空文字）の場合は def を返す。
func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envIntOrDefault は環境変数を正の整数として解釈する。
// 未設定または不正な値（数値でない・0以下）の場合は def を返す。
func envIntOrDefault(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
