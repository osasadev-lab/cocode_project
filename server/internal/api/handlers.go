// api パッケージは cocode の REST API（仕様書§5.5）を実装する。
// セッションの作成、状態取得、終了の3つを担当する。
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

// createSessionReq / createSessionResp: POST /api/sessions のリクエスト/レスポンス型
// （仕様書§5.5、§14.1ステップ5〜6）。
type createSessionReq struct {
	Lat         float64 `json:"lat"`
	Lng         float64 `json:"lng"`
	Address     string  `json:"address"`
	DisplayName string  `json:"displayName"`
	AvatarIcon  string  `json:"avatarIcon"`
}

type createSessionResp struct {
	SessionID     string    `json:"sessionId"`
	TokenHost     string    `json:"tokenHost"`
	ParticipantID string    `json:"participantId"`
	ShareURL      string    `json:"shareUrl"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

// createSession は POST /api/sessions を実装する。目的地は後から設定できる
// 任意項目ではなく必須項目である。仕様書§5.1により、ホストが目的地を決める
// まで共有リンクは存在してはならないため。表示名・アイコンは非空文字チェック
// のみ行い、最大文字数やアイコンのホワイトリスト検証はPhase 3で追加する。
func (h *Handler) createSession(c *gin.Context) {
	var req createSessionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}
	if !validLatLng(req.Lat, req.Lng) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "lat and lng are required and must be valid coordinates"})
		return
	}
	if req.DisplayName == "" || req.AvatarIcon == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "displayName and avatarIcon are required"})
		return
	}

	rec, host, err := h.hub.Create(c.Request.Context(), req.Lat, req.Lng, req.Address, req.DisplayName, req.AvatarIcon)
	if err != nil {
		h.log.Error("create session failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	c.JSON(http.StatusCreated, createSessionResp{
		SessionID:     rec.ID,
		TokenHost:     rec.TokenHost,
		ParticipantID: host.ID,
		ShareURL:      h.publicBaseURL + "/?s=" + rec.ID + "&t=" + rec.TokenGuest,
		ExpiresAt:     rec.ExpiresAt,
	})
}

// participantResp: GET /api/sessions/:id/state のレスポンスに含める参加者の公開情報。
type participantResp struct {
	ID            string                 `json:"id"`
	Role          session.Role           `json:"role"`
	DisplayName   string                 `json:"displayName"`
	AvatarIcon    string                 `json:"avatarIcon"`
	TransportMode session.TransportMode  `json:"transportMode"`
	Live          *session.LocationState `json:"live"`
	ETASeconds    *int                   `json:"etaSeconds"`
}

// destinationResp: GET /api/sessions/:id/state のレスポンスに含める目的地情報。
type destinationResp struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Address   string    `json:"address,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// stateResp: GET /api/sessions/:id/state のレスポンス型（仕様書§5.5、参加登録済みの場合）。
type stateResp struct {
	Role          session.Role      `json:"role"`
	ParticipantID string            `json:"participantId"`
	Destination   destinationResp   `json:"destination"`
	ExpiresAt     time.Time         `json:"expiresAt"`
	Participants  []participantResp `json:"participants"`
}

// guestPreviewResp: GET /api/sessions/:id/state のレスポンス型（仕様書§5.5・§14.2）。
// ゲストが participantId 未指定でアクセスした場合（初回参加前）に返す、
// ゲスト用トップページ表示に必要な最小限のプレビュー。参加者登録は行わず、
// 他参加者の表示名・位置情報など個人情報は一切含めない。
type guestPreviewResp struct {
	DestAddress      string    `json:"destAddress,omitempty"`
	ParticipantCount int       `json:"participantCount"`
	ExpiresAt        time.Time `json:"expiresAt"`
}

// getState は GET /api/sessions/:id/state を実装する。
// ページ再読み込み時、WebSocket が再接続する前の状態同期や、
// ゲスト用トップページのプレビュー表示に使われる（仕様書§5.5）。
func (h *Handler) getState(c *gin.Context) {
	id := c.Param("id")
	token := c.Query("token")
	participantID := c.Query("participantId")

	rec, self, all, err := h.hub.GetState(c.Request.Context(), id, token, participantID)
	if err != nil {
		respondSessionErr(c, err)
		return
	}

	if self == nil {
		// role=guest かつ participantId 未指定: 初回ゲスト向けプレビュー(§5.5, §14.2)。
		c.JSON(http.StatusOK, guestPreviewResp{
			DestAddress:      rec.DestAddress,
			ParticipantCount: len(all),
			ExpiresAt:        rec.ExpiresAt,
		})
		return
	}

	participants := make([]participantResp, 0, len(all))
	for _, p := range all {
		participants = append(participants, participantResp{
			ID:            p.ID,
			Role:          p.Role,
			DisplayName:   p.DisplayName,
			AvatarIcon:    p.AvatarIcon,
			TransportMode: p.TransportMode,
			Live:          p.Live,
			ETASeconds:    p.ETASeconds,
		})
	}

	c.JSON(http.StatusOK, stateResp{
		Role:          self.Role,
		ParticipantID: self.ID,
		Destination: destinationResp{
			Lat:       rec.DestLat,
			Lng:       rec.DestLng,
			Address:   rec.DestAddress,
			UpdatedAt: rec.DestUpdatedAt,
		},
		ExpiresAt:    rec.ExpiresAt,
		Participants: participants,
	})
}

// endSession は POST /api/sessions/:id/end を実装する。
// ホストのトークンのみ受理する（仕様書§5.6）。ゲストトークンでの呼び出しは403。
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
	switch {
	case errors.Is(err, session.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found or expired"})
	case errors.Is(err, session.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed for this role"})
	case errors.Is(err, session.ErrParticipantLimit):
		c.JSON(http.StatusForbidden, gin.H{"error": "session is full"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
	}
}

// validLatLng はゼロ値（項目省略時にデコードされる 0,0 で、このアプリでは
// 現実的にはほぼあり得ない座標）と、有効範囲外の座標を弾く。
func validLatLng(lat, lng float64) bool {
	if lat == 0 && lng == 0 {
		return false
	}
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}
