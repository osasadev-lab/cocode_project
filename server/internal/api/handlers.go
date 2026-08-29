// api パッケージは cocode の REST API（仕様書§7）を実装する。
// セッションの作成、再接続時の状態取得、早期終了の3つを担当する。
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

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

// Register は cocode の REST エンドポイントを r に登録する。
// レート制限がかかるのはセッション作成のみ（仕様書§8-5）。
// 状態取得と終了は既に有効なトークンを要求しており、
// IP ベースの回数制限よりもずっと強いガードになっている。
func (h *Handler) Register(r *gin.Engine) {
	r.POST("/api/sessions", h.createLimiter.middleware(), h.createSession)
	r.GET("/api/sessions/:id/state", h.getState)
	r.POST("/api/sessions/:id/end", h.endSession)
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

// createSession は POST /api/sessions を実装する。待ち合わせ地点は
// 後から設定できる任意項目ではなく必須項目である。仕様書§5.1により、
// A が待ち合わせ場所を決めるまで共有リンクは存在してはならないため。
func (h *Handler) createSession(c *gin.Context) {
	// リクエストボディを検証する。
	var req createSessionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}
	if !validLatLng(req.Lat, req.Lng) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "lat and lng are required and must be valid coordinates"})
		return
	}

	// hub 経由でセッションを作成（永続化＋メモリ登録）する。
	rec, err := h.hub.Create(c.Request.Context(), session.LocationState{
		Lat:       req.Lat,
		Lng:       req.Lng,
		UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		h.log.Error("create session failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	c.JSON(http.StatusCreated, createSessionResp{
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

// getState は GET /api/sessions/:id/state を実装する。
// ページ再読み込み時、WebSocket が再接続する前の状態同期に使われる（仕様書§7）。
func (h *Handler) getState(c *gin.Context) {
	id := c.Param("id")
	token := c.Query("token")

	rec, role, err := h.hub.GetState(c.Request.Context(), id, token)
	if err != nil {
		respondSessionErr(c, err)
		return
	}

	c.JSON(http.StatusOK, stateResp{
		Role:      role,
		ExpiresAt: rec.ExpiresAt,
		Target:    rec.LocATarget,
		LiveA:     rec.LocALive,
		LiveB:     rec.LocBLive,
	})
}

// endSession は POST /api/sessions/:id/end を実装する。
// どちらの参加者からでもセッションを即座に終了できる（仕様書§5.5）。
func (h *Handler) endSession(c *gin.Context) {
	id := c.Param("id")
	token := c.Query("token")

	if err := h.hub.End(c.Request.Context(), id, token); err != nil {
		respondSessionErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// respondSessionErr は session パッケージのエラーを適切な HTTP ステータスに変換する。
func respondSessionErr(c *gin.Context, err error) {
	if errors.Is(err, session.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found or expired"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
}

// validLatLng はゼロ値（項目省略時にデコードされる 0,0 で、このアプリでは
// 現実的にはほぼあり得ない座標）と、有効範囲外の座標を弾く。
func validLatLng(lat, lng float64) bool {
	if lat == 0 && lng == 0 {
		return false
	}
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}
