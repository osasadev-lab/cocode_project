// Command server runs cocode's Go backend: the REST API for creating and
// ending sessions, and the WebSocket endpoint that streams live location
// updates between the two participants of a session.
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

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config error", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	store, err := db.Open(ctx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		logger.Error("db connection failed", "err", err)
		os.Exit(1)
	}
	defer store.Close()

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

	go func() {
		logger.Info("cocode server listening", "port", cfg.Port, "sessionTTL", cfg.SessionTTL.String())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

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
