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
	"github.com/osasadev-lab/cocode_project/server/internal/transitroute"
)

// Handler は REST エンドポイント群の依存関係をまとめて保持する構造体。
type Handler struct {
	hub            *hub.Manager
	publicBaseURL  string
	log            *slog.Logger
	createLimiter  *rateLimiter
	transit        *transitroute.Router
	transitLimiter *rateLimiter
}

// NewHandler は Handler を生成する。
func NewHandler(h *hub.Manager, publicBaseURL string, rateLimitPerMinute int, transit *transitroute.Router, transitRateLimitPerMinute int, log *slog.Logger) *Handler {
	return &Handler{
		hub:            h,
		publicBaseURL:  publicBaseURL,
		log:            log,
		createLimiter:  newRateLimiter(rateLimitPerMinute, time.Minute),
		transit:        transit,
		transitLimiter: newRateLimiter(transitRateLimitPerMinute, time.Minute),
	}
}

// Register は cocode の REST エンドポイントを r に登録する。
// レート制限がかかるのはセッション作成・電車ETA取得のみ（仕様書§8-5, §7.1）。
// 状態取得と終了は既に有効なトークンを要求しており、
// IP ベースの回数制限よりもずっと強いガードになっている。
func (h *Handler) Register(r *gin.Engine) {
	r.POST("/api/sessions", h.createLimiter.middleware(), h.createSession)
	r.GET("/api/sessions/:id/state", h.getState)
	r.POST("/api/sessions/:id/end", h.endSession)
	r.POST("/api/sessions/:id/regenerate-link", h.regenerateLink)
	r.POST("/api/eta/transit", h.transitLimiter.middleware(), h.etaTransit)
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
// まで共有リンクは存在してはならないため。表示名・アイコンは
// session.ValidDisplayName/ValidAvatarIcon で検証する(仕様書§6, §6.1)。
func (h *Handler) createSession(c *gin.Context) {
	var req createSessionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "リクエストの形式が正しくありません"})
		return
	}
	if !validLatLng(req.Lat, req.Lng) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "緯度・経度を正しく指定してください"})
		return
	}
	if !session.ValidDisplayName(req.DisplayName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "表示名を入力してください(20文字以内)"})
		return
	}
	if !session.ValidAvatarIcon(req.AvatarIcon) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "アイコンの指定が正しくありません"})
		return
	}

	rec, host, err := h.hub.Create(c.Request.Context(), req.Lat, req.Lng, req.Address, req.DisplayName, req.AvatarIcon)
	if err != nil {
		h.log.Error("create session failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "セッションの作成に失敗しました"})
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
	ID              string                 `json:"id"`
	Role            session.Role           `json:"role"`
	DisplayName     string                 `json:"displayName"`
	AvatarIcon      string                 `json:"avatarIcon"`
	TransportMode   session.TransportMode  `json:"transportMode"`
	Live            *session.LocationState `json:"live"`
	ETASeconds      *int                   `json:"etaSeconds"`
	LocationSharing bool                   `json:"locationSharing"`
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
	DestAddress string `json:"destAddress,omitempty"`
	// 目的地の座標(2026-08-31追加)。ゲストが参加確定(WS接続)する前の時点で、
	// 現在地→目的地の全体経路を見ながら移動手段を選べるようにするため
	// (仕様書§14.2改訂)。他参加者の個人情報(表示名・位置情報等)とは異なり、
	// 目的地自体は招待の主目的であり、destAddress(住所文字列)は元々この
	// プレビューで開示していたため、座標の追加開示は既存の情報公開範囲を
	// 実質的に広げるものではない。
	DestLat          float64   `json:"destLat"`
	DestLng          float64   `json:"destLng"`
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
			DestLat:          rec.DestLat,
			DestLng:          rec.DestLng,
			ParticipantCount: len(all),
			ExpiresAt:        rec.ExpiresAt,
		})
		return
	}

	participants := make([]participantResp, 0, len(all))
	for _, p := range all {
		participants = append(participants, participantResp{
			ID:              p.ID,
			Role:            p.Role,
			DisplayName:     p.DisplayName,
			AvatarIcon:      p.AvatarIcon,
			TransportMode:   p.TransportMode,
			Live:            p.Live,
			ETASeconds:      p.ETASeconds,
			LocationSharing: p.LocationSharing,
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

// regenerateLinkResp: POST /api/sessions/:id/regenerate-link のレスポンス。
type regenerateLinkResp struct {
	TokenHost string    `json:"tokenHost"`
	ShareURL  string    `json:"shareUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// regenerateLink は POST /api/sessions/:id/regenerate-link を実装する。
// ホスト/ゲスト双方のトークンを新しい値へ差し替え、以後古いトークンでの
// 新規参加・再接続を拒否させる（トークン漏えいが疑われる場合の安全弁、新設）。
// ホストのトークンのみ受理する（仕様書§5.6のendSessionと同じ認可パターン）。
func (h *Handler) regenerateLink(c *gin.Context) {
	id := c.Param("id")
	token := c.Query("token")

	rec, err := h.hub.RegenerateTokens(c.Request.Context(), id, token)
	if err != nil {
		respondSessionErr(c, err)
		return
	}

	c.JSON(http.StatusOK, regenerateLinkResp{
		TokenHost: rec.TokenHost,
		ShareURL:  h.publicBaseURL + "/?s=" + rec.ID + "&t=" + rec.TokenGuest,
		ExpiresAt: rec.ExpiresAt,
	})
}

// respondSessionErr は session パッケージのエラーを適切な HTTP ステータスに変換する。
func respondSessionErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, session.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "セッションが見つからないか、既に終了しています"})
	case errors.Is(err, session.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "この操作を行う権限がありません"})
	case errors.Is(err, session.ErrParticipantLimit):
		c.JSON(http.StatusForbidden, gin.H{"error": "参加人数が上限に達しています"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "サーバー内部でエラーが発生しました"})
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

type etaTransitReq struct {
	FromLat float64 `json:"fromLat"`
	FromLng float64 `json:"fromLng"`
	ToLat   float64 `json:"toLat"`
	ToLng   float64 `json:"toLng"`
}

type etaTransitResp struct {
	ETASeconds int                 `json:"etaSeconds"`
	Polyline   string              `json:"polyline"`
	Steps      []transitroute.Step `json:"steps"`
}

// etaTransit は POST /api/eta/transit を実装する（仕様書§7.1〜§7.1.3）。
// NAVITIME/ジョルダンいずれのAPIキーもフロントエンドへ露出させないため、
// 必ずこのバックエンド経由で呼び出す。どちらのプロバイダを使うかはh.transit
// (transitroute.Router)が内部で判断し、このハンドラは意識しない。
func (h *Handler) etaTransit(c *gin.Context) {
	var req etaTransitReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "リクエストの形式が正しくありません"})
		return
	}
	if !validLatLng(req.FromLat, req.FromLng) || !validLatLng(req.ToLat, req.ToLng) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "出発地・目的地の座標を正しく指定してください"})
		return
	}

	route, err := h.transit.ComputeRoute(c.Request.Context(),
		transitroute.LatLng{Lat: req.FromLat, Lng: req.FromLng},
		transitroute.LatLng{Lat: req.ToLat, Lng: req.ToLng},
	)
	if errors.Is(err, transitroute.ErrNoRoute) {
		c.JSON(http.StatusNotFound, gin.H{"error": "電車の経路が見つかりませんでした"})
		return
	}
	if errors.Is(err, transitroute.ErrNoProviderAvailable) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "電車の所要時間の算出が現在利用できません"})
		return
	}
	if err != nil {
		h.log.Error("compute transit route failed", "err", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "電車の経路の算出に失敗しました"})
		return
	}

	c.JSON(http.StatusOK, etaTransitResp{
		ETASeconds: route.ETASeconds,
		Polyline:   route.Polyline,
		Steps:      route.Steps,
	})
}
