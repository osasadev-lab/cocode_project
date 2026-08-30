package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/osasadev-lab/cocode_project/server/internal/feedbackmail"
)

const maxFeedbackMessageLength = 2000

// FeedbackStore はfeedbacksテーブルへの保存だけを担う、api層専用の薄いインターフェース。
// session.Storeとは別物（フィードバックはセッションのドメインに属さないため）。
type FeedbackStore interface {
	InsertFeedback(ctx context.Context, message, replyTo, context_ string) (id string, createdAt time.Time, err error)
}

// FeedbackHandler は POST /api/feedback を扱う（仕様書§17.2）。
type FeedbackHandler struct {
	store       FeedbackStore
	mailCfg     feedbackmail.Config
	log         *slog.Logger
	rateLimiter *rateLimiter
}

// NewFeedbackHandler は FeedbackHandler を生成する。
func NewFeedbackHandler(store FeedbackStore, mailCfg feedbackmail.Config, log *slog.Logger) *FeedbackHandler {
	return &FeedbackHandler{
		store:       store,
		mailCfg:     mailCfg,
		log:         log,
		rateLimiter: newRateLimiter(3, time.Hour), // 1IPあたり1時間に3件まで（仕様書§17.2）
	}
}

// Register は /api/feedback を r に登録する。
func (h *FeedbackHandler) Register(r *gin.Engine) {
	r.POST("/api/feedback", h.rateLimiter.middleware(), h.create)
}

type createFeedbackReq struct {
	Message string `json:"message"`
	ReplyTo string `json:"replyTo"`
	Context string `json:"context"`
}

// create は POST /api/feedback を実装する。DBに一次記録として保存した上で、
// コミット後にベストエフォートでosasadev@gmail.com宛にメール通知する
// （仕様書§17.2、aiboのfeedbackmailパターンを踏襲）。
func (h *FeedbackHandler) create(c *gin.Context) {
	var req createFeedbackReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}
	if req.Message == "" || utf8.RuneCountInString(req.Message) > maxFeedbackMessageLength {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message is required and must be 2000 characters or fewer"})
		return
	}

	_, createdAt, err := h.store.InsertFeedback(c.Request.Context(), req.Message, req.ReplyTo, req.Context)
	if err != nil {
		h.log.Error("insert feedback failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save feedback"})
		return
	}

	feedbackmail.Async(h.mailCfg, feedbackmail.Item{
		Message:   req.Message,
		ReplyTo:   req.ReplyTo,
		Context:   req.Context,
		CreatedAt: createdAt,
	})

	c.Status(http.StatusCreated)
}
