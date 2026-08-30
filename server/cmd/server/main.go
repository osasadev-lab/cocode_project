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

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"github.com/osasadev-lab/cocode_project/server/internal/api"
	"github.com/osasadev-lab/cocode_project/server/internal/config"
	"github.com/osasadev-lab/cocode_project/server/internal/db"
	"github.com/osasadev-lab/cocode_project/server/internal/feedbackmail"
	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/transitroute"
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

	engine := gin.New()
	engine.Use(gin.Recovery())
	// WebSocket へのアップグレードは CORS の対象外（ws.upgrader の CheckOrigin が扱う）
	// なので、このミドルウェアが関係するのは /api/* 系のルートのみ。
	engine.Use(cors.New(cors.Config{
		AllowOrigins: []string{cfg.PublicBaseURL},
		AllowMethods: []string{"GET", "POST", "OPTIONS"},
		AllowHeaders: []string{"Content-Type"},
	}))
	engine.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	// 電車ETAプロバイダ: NAVITIME優先、無料枠超過時はジョルダンへ自動フォール
	// バック(仕様書§7.1〜§7.1.3)。ジョルダンは審査待ちのため、アクセスキー未
	// 設定の間はConfigured()がfalseを返しRouterから自動的にスキップされる。
	navitimeClient := transitroute.NewNavitimeClient(cfg.NavitimeAPIKey)
	stationResolver := transitroute.NewMapTilerStationResolver(cfg.MapTilerKey)
	jorudanClient := transitroute.NewJorudanClient(cfg.JorudanAccessKey, cfg.JorudanBaseURL, stationResolver)
	transitRouter := transitroute.NewRouter(navitimeClient, jorudanClient, store, logger)
	api.NewHandler(manager, cfg.PublicBaseURL, cfg.RateLimitRPM, transitRouter, cfg.TransitRateLimitRPM, logger).Register(engine)
	ws.NewHandler(manager, logger).Register(engine)

	mailCfg := feedbackmail.Config{
		Host:        cfg.SMTPHost,
		Port:        cfg.SMTPPort,
		Username:    cfg.SMTPUsername,
		Password:    cfg.SMTPPassword,
		NotifyEmail: cfg.FeedbackNotifyEmail,
	}
	api.NewFeedbackHandler(store, mailCfg, logger).Register(engine)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           engine,
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
