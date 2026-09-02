// ws パッケージは cocode のリアルタイム通信を担う。
// セッションが続く間、ホスト・ゲスト双方が保持し続ける /ws エンドポイントで、
// ライブ位置情報の更新を配信する（仕様書§5.4）。
package ws

import (
	"context"
	"encoding/json"
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
	// AnnounceRejoin: 明示的に退出した後、招待リンクから再入室したゲストの
	// 再接続であることをクライアントが伝えるフラグ（2026-09-01新設、
	// web/lib/useCocodeSocket.ts参照）。参加者IDが未指定（新規参加）の場合は無視される。
	AnnounceRejoin bool `json:"announceRejoin"`
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
	ID              string                 `json:"id"`
	Role            session.Role           `json:"role"`
	DisplayName     string                 `json:"displayName"`
	AvatarIcon      string                 `json:"avatarIcon"`
	TransportMode   session.TransportMode  `json:"transportMode"`
	Live            *session.LocationState `json:"live"`
	ETASeconds      *int                   `json:"etaSeconds"`
	Arrived         bool                   `json:"arrived"`
	LocationSharing bool                   `json:"locationSharing"`
}

// syncPayload は Join 成功直後に送られる初回の "sync" フレームで、
// クライアントへセッションの現在の完全な状態を渡す。
// ActivityLog(新設): room が保持する直近のチャットログ（参加/退出/到着/
// ひとことメッセージ）を、参加・再接続のたびに含めて配信する。これにより
// リロード後もチャット履歴が失われない（p7残課題の対応）。
type syncPayload struct {
	Type          string              `json:"type"`
	Role          session.Role        `json:"role"`
	ParticipantID string              `json:"participantId"`
	Destination   destinationPayload  `json:"destination"`
	ExpiresAt     time.Time           `json:"expiresAt"`
	Participants  []participantPublic `json:"participants"`
	ActivityLog   []hub.ActivityEntry `json:"activityLog"`
}

// inboundMsg は認証後にクライアントからサーバーへ送られるフレームの形式
// （仕様書§5.4）。Kindは location_update("target"/"live") と
// expression("stamp"/"reaction") の両方で使い回すため、session.Kind型では
// なくstring型にしている（location_updateの処理側でのみsession.Kind(msg.Kind)
// へ変換する）。
type inboundMsg struct {
	Type          string          `json:"type"`
	Kind          string          `json:"kind"`
	Lat           float64         `json:"lat"`
	Lng           float64         `json:"lng"`
	Accuracy      float64         `json:"accuracy"`
	Address       string          `json:"address"`
	DisplayName   string          `json:"displayName"`   // profile_update 用
	AvatarIcon    string          `json:"avatarIcon"`    // profile_update 用
	TransportMode string          `json:"transportMode"` // location_update(kind=live)/transport_update 用
	ETASeconds    *int            `json:"etaSeconds"`    // location_update(kind=live)/transport_update 用
	RoutePolyline string          `json:"routePolyline"` // location_update(kind=live, 電車モード) 用
	RouteSteps    json.RawMessage `json:"routeSteps"`    // location_update(kind=live, 電車モード) 用
	Text          string          `json:"text"`          // expression(kind=stamp) 用
	Sharing       *bool           `json:"sharing"`       // location_sharing_update 用(新設)
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
	rec, self, all, activity, err := h.hub.Join(ctx, auth.SessionID, auth.Token, auth.ParticipantID, auth.DisplayName, auth.AvatarIcon, auth.AnnounceRejoin, conn)
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
		ActivityLog:  activity,
	}); err != nil {
		h.hub.Disconnect(auth.SessionID, self.ID, conn)
		return
	}

	// 4. 接続が切れるまでメッセージを受信し続ける。
readLoop:
	for {
		var msg inboundMsg
		if err := wsConn.ReadJSON(&msg); err != nil {
			// JSONの型不一致・構文エラーはメッセージの内容だけが不正で、
			// 接続自体は生きている（2026-08-31発見: フロントエンドが
			// etaSecondsに小数を送ってしまうバグで、ETASeconds *int への
			// アンマーシャル失敗がそのままセッション全体の強制切断に繋がって
			// いた）。1件の不正なメッセージでセッションを丸ごと落とさない
			// よう、このメッセージだけ無視して受信を継続する。
			var typeErr *json.UnmarshalTypeError
			var syntaxErr *json.SyntaxError
			if errors.As(err, &typeErr) || errors.As(err, &syntaxErr) {
				h.log.Warn("ignoring malformed ws message", "session", auth.SessionID, "participant", self.ID, "err", err)
				continue
			}
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
			extra := hub.LiveExtras{
				TransportMode: session.TransportMode(msg.TransportMode),
				ETASeconds:    msg.ETASeconds,
				RoutePolyline: msg.RoutePolyline,
				RouteSteps:    msg.RouteSteps,
			}
			if err := h.hub.UpdateLocation(ctx, auth.SessionID, self.ID, session.Kind(msg.Kind), loc, msg.Address, extra); err != nil {
				h.log.Warn("rejected location update", "session", auth.SessionID, "participant", self.ID, "err", err)
			}
		case "transport_update":
			if err := h.hub.UpdateTransport(ctx, auth.SessionID, self.ID, session.TransportMode(msg.TransportMode), msg.ETASeconds); err != nil {
				_ = conn.Send(map[string]string{"type": "error", "message": "移動手段の指定が正しくありません"})
			}
		case "profile_update":
			if err := h.hub.UpdateProfile(ctx, auth.SessionID, self.ID, msg.DisplayName, msg.AvatarIcon); err != nil {
				_ = conn.Send(map[string]string{"type": "error", "message": profileUpdateErrorMessage(err)})
			}
		case "expression":
			if err := h.hub.SendExpression(auth.SessionID, self.ID, msg.Kind, msg.Text); err != nil {
				_ = conn.Send(map[string]string{"type": "error", "message": expressionErrorMessage(err)})
			}
		case "location_sharing_update":
			if msg.Sharing == nil {
				_ = conn.Send(map[string]string{"type": "error", "message": "位置情報共有の指定が正しくありません"})
				break
			}
			if err := h.hub.UpdateLocationSharing(ctx, auth.SessionID, self.ID, *msg.Sharing); err != nil {
				_ = conn.Send(map[string]string{"type": "error", "message": "位置情報共有の切り替えに失敗しました"})
			}
		case "leave":
			// ゲストの明示的な「退出する」操作（仕様書§14.3ステップ12、新設）。
			// 復帰猶予を待たず即座に恒久退出として扱う（hub.Leave参照）。
			//
			// 成功時はここで読み取りループごと終了し、サーバー側から接続を閉じる
			// (defer wsConn.Close()、2026-09-02修正)。以前はクライアント側が
			// "leave"送信の直後に自らclose()する設計だったが、ブラウザによっては
			// send()した"leave"フレームが実際に送信される前にclose()で接続が
			// 切られてしまうことがあり、その場合サーバーは"leave"を受け取れないまま
			// ただの切断として扱ってしまう(=復帰猶予10分待ちの経路に乗ってしまい、
			// 退出したのに参加人数がすぐ減らない不具合の原因だった)。ここで
			// hub.Leave(=removeParticipant、恒久退出・ブロードキャスト済み)が
			// 確実に完了してから接続を閉じることで、この競合を無くす。
			if err := h.hub.Leave(ctx, auth.SessionID, auth.Token, self.ID); err != nil {
				_ = conn.Send(map[string]string{"type": "error", "message": "退出処理に失敗しました"})
				break
			}
			break readLoop
		default:
			// 未知の type は無視する。
		}
	}

	// 5. 読み取りループを抜けた（＝接続が切れた）ので後始末する。
	h.hub.Disconnect(auth.SessionID, self.ID, conn)
}

// joinErrorMessage は hub.Join のエラーを、クライアントへ送る簡潔な文言に変換する。
func joinErrorMessage(err error) string {
	switch {
	case errors.Is(err, session.ErrParticipantLimit):
		return "参加人数が上限に達しています"
	case errors.Is(err, session.ErrForbidden):
		return "表示名・アイコンの指定が正しくありません"
	default:
		return "セッションが見つからないか、既に終了しています"
	}
}

// profileUpdateErrorMessage は hub.UpdateProfile のエラーを、クライアントへ送る
// 簡潔な文言に変換する（joinErrorMessage と同じパターン）。
func profileUpdateErrorMessage(err error) string {
	switch {
	case errors.Is(err, session.ErrRateLimited):
		return "表示名・アイコンの変更は5秒に1回までです"
	case errors.Is(err, session.ErrForbidden):
		return "表示名・アイコンの指定が正しくありません"
	default:
		return "プロフィールの更新に失敗しました"
	}
}

// expressionErrorMessage は hub.SendExpression のエラーを、クライアントへ送る
// 簡潔な文言に変換する。
func expressionErrorMessage(err error) string {
	switch {
	case errors.Is(err, session.ErrRateLimited):
		return "スタンプ・リアクションの送信は3秒に1回までです"
	case errors.Is(err, session.ErrForbidden):
		return "スタンプ・リアクションの指定が正しくありません"
	default:
		return "スタンプ・リアクションの送信に失敗しました"
	}
}

// toParticipantPublic は session.Participant を sync フレーム用の公開表現に変換する。
func toParticipantPublic(p *session.Participant) participantPublic {
	return participantPublic{
		ID:              p.ID,
		Role:            p.Role,
		DisplayName:     p.DisplayName,
		AvatarIcon:      p.AvatarIcon,
		TransportMode:   p.TransportMode,
		Live:            p.Live,
		ETASeconds:      p.ETASeconds,
		Arrived:         p.ArrivedAt != nil,
		LocationSharing: p.LocationSharing,
	}
}
