// Command server runs cocode's Go backend: the REST API for creating and
// ending sessions, and the WebSocket endpoint that streams live location
// updates between the two participants of a session.
// main コマンドは cocode の Go バックエンドを起動する。
// セッションの作成・終了を行う REST API と、
// セッション参加者2人の間でライブ位置情報を配信する WebSocket
// エンドポイントの両方をここで組み立てる。
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/osasadev-lab/cocode_project/server/internal/api"
	"github.com/osasadev-lab/cocode_project/server/internal/config"
	"github.com/osasadev-lab/cocode_project/server/internal/db"
	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/ws"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// 1. 環境変数から設定を読み込む。
	cfg, err := config.Load()
	if err != nil {
		logger.Error("config error", "err", err)
		os.Exit(1)
	}

	// 2. Postgres へ接続する（10秒でタイムアウト）。
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	store, err := db.Open(ctx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		logger.Error("db connection failed", "err", err)
		os.Exit(1)
	}
	defer store.Close()

	// 3. セッション管理（hub）と HTTP ルーティングを組み立てる。
	manager := hub.NewManager(store, cfg.SessionTTL, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	api.NewHandler(manager, cfg.PublicBaseURL, cfg.RateLimitRPM, logger).Register(mux)
	ws.NewHandler(manager, logger).Register(mux)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           withCORS(cfg.PublicBaseURL, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 4. サーバーをバックグラウンドで起動する。
	go func() {
		logger.Info("cocode server listening", "port", cfg.Port, "sessionTTL", cfg.SessionTTL.String())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// 5. シグナルを受け取ったら、猶予時間内にグレースフルシャットダウンする。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
}

// withCORS lets the frontend, served from a different origin on Firebase
// Hosting, call the REST API on Cloud Run. WebSocket upgrades aren't
// subject to CORS (handled instead by ws.upgrader's CheckOrigin), so this
// only matters for the /api/* routes.
// withCORS は、Firebase Hosting 上の別オリジンから配信されるフロントエンドが
// Cloud Run 上の REST API を呼び出せるようにする。WebSocket への
// アップグレードは CORS の対象外（代わりに ws.upgrader の CheckOrigin が扱う）
// なので、これが関係するのは /api/* 系のルートのみ。
func withCORS(allowedOrigin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
