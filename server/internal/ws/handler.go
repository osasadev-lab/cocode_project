// ws パッケージは cocode のリアルタイム通信を担う。
// セッションが続く間、ホスト・ゲスト双方が保持し続ける /ws エンドポイントで、
// ライブ位置情報の更新を配信する（仕様書§5.4）。
package ws

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// フロントエンド（Firebase Hosting）とバックエンド（Cloud Run）は
	// 意図的に別オリジンになっている。アクセス制御は同一オリジンではなく
	// 認証フレームのトークンで行うため、Origin はここでは全て許可する。
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Conn は gorilla の websocket コネクションを hub.Conn に適合させるアダプタ。
// gorilla は並行書き込みを許可しないため mutex で書き込みを直列化する。
// hub はこのコネクション自身の読み取りループとは別の goroutine から
// ブロードキャストを行うため、この直列化が必要になる。
type Conn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

// Send はメッセージを JSON として書き込む（並行書き込み対策の mutex 付き）。
func (c *Conn) Send(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(v)
}

// Close は WebSocket コネクションを閉じる。
func (c *Conn) Close() error {
	return c.ws.Close()
}

// コンパイル時に Conn が hub.Conn を満たしていることを保証する。
var _ hub.Conn = (*Conn)(nil)

// Handler は /ws エンドポイントの HTTP ハンドラ。
type Handler struct {
	hub *hub.Manager
	log *slog.Logger
}

// NewHandler は Handler を生成する。
func NewHandler(h *hub.Manager, log *slog.Logger) *Handler {
	return &Handler{hub: h, log: log}
}

// Register は /ws エンドポイントを r に登録する。
func (h *Handler) Register(r *gin.Engine) {
	r.GET("/ws", h.serve)
}

// authFrame は WebSocket へのアップグレード直後にクライアントが最初に送る
// 認証メッセージ（仕様書§5.4）。セッション id・トークンをクエリ文字列に
// 含めないことで、Cloud Run のアクセスログに残らないようにしている。
// participantId は再接続時のみ、displayName/avatarIcon は初回参加時のみ必須。
type authFrame struct {
	SessionID     string `json:"sessionId"`
	Token         string `json:"token"`
	ParticipantID string `json:"participantId"`
	DisplayName   string `json:"displayName"`
	AvatarIcon    string `json:"avatarIcon"`
}

// destinationPayload は sync フレームに含める目的地情報。
type destinationPayload struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Address   string    `json:"address,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// participantPublic は sync フレームで各参加者について配信する公開情報
// （仕様書§5.4）。Live/ETASeconds は未設定時 JSON 上で null を明示するため
// omitempty を付けない。
type participantPublic struct {
	ID            string                 `json:"id"`
	Role          session.Role           `json:"role"`
	DisplayName   string                 `json:"displayName"`
	AvatarIcon    string                 `json:"avatarIcon"`
	TransportMode session.TransportMode  `json:"transportMode"`
	Live          *session.LocationState `json:"live"`
	ETASeconds    *int                   `json:"etaSeconds"`
}

// syncPayload は Join 成功直後に送られる初回の "sync" フレームで、
// クライアントへセッションの現在の完全な状態を渡す。
type syncPayload struct {
	Type          string              `json:"type"`
	Role          session.Role        `json:"role"`
	ParticipantID string              `json:"participantId"`
	Destination   destinationPayload  `json:"destination"`
	ExpiresAt     time.Time           `json:"expiresAt"`
	Participants  []participantPublic `json:"participants"`
}

// inboundMsg は認証後にクライアントからサーバーへ送られるフレームの形式
// （仕様書§5.4）。Phase 2時点では location_update のみ処理し、
// transport_update/expression/profile_update はPhase 3〜5で追加する。
type inboundMsg struct {
	Type     string       `json:"type"`
	Kind     session.Kind `json:"kind"`
	Lat      float64      `json:"lat"`
	Lng      float64      `json:"lng"`
	Accuracy float64      `json:"accuracy"`
	Address  string       `json:"address"`
}

// serve は /ws への接続1本ぶんの処理全体を担う。
// 1. HTTP から WebSocket へアップグレード
// 2. 認証フレームの受信とセッションへの参加（hub.Join）
// 3. 初回同期（sync）フレームの送信
// 4. 位置情報更新メッセージを受信し続けるループ
// 5. 切断時のクリーンアップ（hub.Disconnect）
func (h *Handler) serve(c *gin.Context) {
	// 1. WebSocket へアップグレードする。
	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.log.Warn("ws upgrade failed", "err", err)
		return
	}
	conn := &Conn{ws: wsConn}
	defer wsConn.Close()

	// 2. 最初のフレームは必ず認証ハンドシェイクでなければならない。
	// アイドル接続を無限に待たないよう、短い猶予時間だけ設定する。
	_ = wsConn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var auth authFrame
	if err := wsConn.ReadJSON(&auth); err != nil {
		return
	}
	_ = wsConn.SetReadDeadline(time.Time{})

	ctx := context.Background()
	rec, self, all, err := h.hub.Join(ctx, auth.SessionID, auth.Token, auth.ParticipantID, auth.DisplayName, auth.AvatarIcon, conn)
	if err != nil {
		_ = conn.Send(map[string]string{"type": "error", "message": joinErrorMessage(err)})
		return
	}

	// 3. 現在のセッション状態をまとめて送り、クライアントを同期させる。
	participants := make([]participantPublic, 0, len(all))
	for _, p := range all {
		participants = append(participants, toParticipantPublic(p))
	}
	if err := conn.Send(syncPayload{
		Type:          "sync",
		Role:          self.Role,
		ParticipantID: self.ID,
		Destination: destinationPayload{
			Lat:       rec.DestLat,
			Lng:       rec.DestLng,
			Address:   rec.DestAddress,
			UpdatedAt: rec.DestUpdatedAt,
		},
		ExpiresAt:    rec.ExpiresAt,
		Participants: participants,
	}); err != nil {
		h.hub.Disconnect(auth.SessionID, self.ID, conn)
		return
	}

	// 4. 接続が切れるまでメッセージを受信し続ける。
	for {
		var msg inboundMsg
		if err := wsConn.ReadJSON(&msg); err != nil {
			break
		}
		switch msg.Type {
		case "location_update":
			loc := session.LocationState{
				Lat:       msg.Lat,
				Lng:       msg.Lng,
				Accuracy:  msg.Accuracy,
				UpdatedAt: time.Now().UTC(),
			}
			if err := h.hub.UpdateLocation(ctx, auth.SessionID, self.ID, msg.Kind, loc, msg.Address); err != nil {
				h.log.Warn("rejected location update", "session", auth.SessionID, "participant", self.ID, "err", err)
			}
		default:
			// transport_update / expression / profile_update はPhase 3〜5で追加する
			// 前提で switch 文にしてある。未知の type は現時点では無視する。
		}
	}

	// 5. 読み取りループを抜けた（＝接続が切れた）ので後始末する。
	h.hub.Disconnect(auth.SessionID, self.ID, conn)
}

// joinErrorMessage は hub.Join のエラーを、クライアントへ送る簡潔な文言に変換する。
func joinErrorMessage(err error) string {
	switch {
	case errors.Is(err, session.ErrParticipantLimit):
		return "session is full"
	case errors.Is(err, session.ErrForbidden):
		return "displayName and avatarIcon are required"
	default:
		return "session not found or expired"
	}
}

// toParticipantPublic は session.Participant を sync フレーム用の公開表現に変換する。
func toParticipantPublic(p *session.Participant) participantPublic {
	return participantPublic{
		ID:            p.ID,
		Role:          p.Role,
		DisplayName:   p.DisplayName,
		AvatarIcon:    p.AvatarIcon,
		TransportMode: p.TransportMode,
		Live:          p.Live,
		ETASeconds:    p.ETASeconds,
	}
}
