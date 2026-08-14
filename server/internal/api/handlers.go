// Package api implements cocode's REST surface (spec §7): creating a
// session, reading its current state on reconnect, and ending it early.
// api パッケージは cocode の REST API（仕様書§7）を実装する。
// セッションの作成、再接続時の状態取得、早期終了の3つを担当する。
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

// Handler は REST エンドポイント群の依存関係をまとめて保持する構造体。
type Handler struct {
	hub           *hub.Manager
	publicBaseURL string
	log           *slog.Logger
	createLimiter *rateLimiter
}

// NewHandler は Handler を生成する。
func NewHandler(h *hub.Manager, publicBaseURL string, rateLimitPerMinute int, log *slog.Logger) *Handler {
	return &Handler{
		hub:           h,
		publicBaseURL: publicBaseURL,
		log:           log,
		createLimiter: newRateLimiter(rateLimitPerMinute, time.Minute),
	}
}

// Register wires cocode's REST endpoints onto mux. Only session creation is
// rate-limited (spec §8-5) — reading state and ending a session require a
// valid token already, which is a much stronger gate than an IP count.
// Register は cocode の REST エンドポイントを mux に登録する。
// レート制限がかかるのはセッション作成のみ（仕様書§8-5）。
// 状態取得と終了は既に有効なトークンを要求しており、
// IP ベースの回数制限よりもずっと強いガードになっている。
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("POST /api/sessions", h.createLimiter.middleware(http.HandlerFunc(h.createSession)))
	mux.HandleFunc("GET /api/sessions/{id}/state", h.getState)
	mux.HandleFunc("POST /api/sessions/{id}/end", h.endSession)
}

// createSessionReq / createSessionResp: POST /api/sessions のリクエスト/レスポンス型。
type createSessionReq struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type createSessionResp struct {
	SessionID string    `json:"sessionId"`
	TokenA    string    `json:"tokenA"`
	ShareURL  string    `json:"shareUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// createSession implements POST /api/sessions. The meeting point is a
// required field, not an optional follow-up call: spec §5.1 says a share
// link must never exist before A has set where to meet.
// createSession は POST /api/sessions を実装する。待ち合わせ地点は
// 後から設定できる任意項目ではなく必須項目である。仕様書§5.1により、
// A が待ち合わせ場所を決めるまで共有リンクは存在してはならないため。
func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	// リクエストボディを検証する。
	var req createSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !validLatLng(req.Lat, req.Lng) {
		writeError(w, http.StatusBadRequest, "lat and lng are required and must be valid coordinates")
		return
	}

	// hub 経由でセッションを作成（永続化＋メモリ登録）する。
	rec, err := h.hub.Create(r.Context(), session.LocationState{
		Lat:       req.Lat,
		Lng:       req.Lng,
		UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		h.log.Error("create session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	writeJSON(w, http.StatusCreated, createSessionResp{
		SessionID: rec.ID,
		TokenA:    rec.TokenA,
		ShareURL:  h.publicBaseURL + "/?s=" + rec.ID + "&t=" + rec.TokenB,
		ExpiresAt: rec.ExpiresAt,
	})
}

// stateResp: GET /api/sessions/:id/state のレスポンス型。
type stateResp struct {
	Role      session.Role           `json:"role"`
	ExpiresAt time.Time              `json:"expiresAt"`
	Target    session.LocationState  `json:"target"`
	LiveA     *session.LocationState `json:"liveA,omitempty"`
	LiveB     *session.LocationState `json:"liveB,omitempty"`
}

// getState implements GET /api/sessions/:id/state, used on page reload to
// re-sync before the WebSocket reconnects (spec §7).
// getState は GET /api/sessions/:id/state を実装する。
// ページ再読み込み時、WebSocket が再接続する前の状態同期に使われる（仕様書§7）。
func (h *Handler) getState(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")

	rec, role, err := h.hub.GetState(r.Context(), id, token)
	if err != nil {
		respondSessionErr(w, err)
		return
	}

	writeJSON(w, http.StatusOK, stateResp{
		Role:      role,
		ExpiresAt: rec.ExpiresAt,
		Target:    rec.LocATarget,
		LiveA:     rec.LocALive,
		LiveB:     rec.LocBLive,
	})
}

// endSession implements POST /api/sessions/:id/end: either participant can
// terminate the session immediately (spec §5.5).
// endSession は POST /api/sessions/:id/end を実装する。
// どちらの参加者からでもセッションを即座に終了できる（仕様書§5.5）。
func (h *Handler) endSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")

	if err := h.hub.End(r.Context(), id, token); err != nil {
		respondSessionErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// respondSessionErr は session パッケージのエラーを適切な HTTP ステータスに変換する。
func respondSessionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, session.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session not found or expired")
		return
	}
	writeError(w, http.StatusInternalServerError, "internal error")
}

// validLatLng rejects the zero value (an omitted field decodes to 0,0,
// which is a real but vanishingly unlikely coordinate for this app) as
// well as anything outside the valid coordinate range.
// validLatLng はゼロ値（項目省略時にデコードされる 0,0 で、このアプリでは
// 現実的にはほぼあり得ない座標）と、有効範囲外の座標を弾く。
func validLatLng(lat, lng float64) bool {
	if lat == 0 && lng == 0 {
		return false
	}
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// writeJSON は任意の値を JSON レスポンスとして書き込む共通ヘルパー。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError はエラーメッセージを JSON 形式で書き込む共通ヘルパー。
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
