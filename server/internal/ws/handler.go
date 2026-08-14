// Package ws implements cocode's realtime transport: the /ws endpoint that
// both participants hold open for the life of a session, streaming live
// location updates in both directions (spec §4, §7).
// ws パッケージは cocode のリアルタイム通信を担う。
// セッションが続く間、双方の参加者が保持し続ける /ws エンドポイントで、
// ライブ位置情報の更新を双方向にストリーミングする（仕様書§4, §7）。
package ws

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// The frontend (Firebase Hosting) and backend (Cloud Run) are
	// deliberately different origins; the auth frame's token is what
	// gates access, not same-origin, so any Origin is accepted here.
	// フロントエンド（Firebase Hosting）とバックエンド（Cloud Run）は
	// 意図的に別オリジンになっている。アクセス制御は同一オリジンではなく
	// 認証フレームのトークンで行うため、Origin はここでは全て許可する。
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Conn adapts a gorilla websocket connection to hub.Conn. It serializes
// writes with a mutex because gorilla forbids concurrent writers, and the
// hub broadcasts from a different goroutine than this connection's own
// read loop.
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

// Register は /ws エンドポイントを ServeMux に登録する。
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", h.serve)
}

// authFrame is the first message a client must send right after the
// upgrade, carrying the session id and token. Keeping these out of the
// query string keeps them out of Cloud Run's access logs (spec §8-2).
// authFrame は WebSocket へのアップグレード直後にクライアントが最初に送る
// 認証メッセージで、セッション id とトークンを運ぶ。これらをクエリ文字列に
// 含めないことで、Cloud Run のアクセスログに残らないようにしている（仕様書§8-2）。
type authFrame struct {
	SessionID string `json:"sessionId"`
	Token     string `json:"token"`
}

// inboundMsg is the shape of every client->server frame after auth (spec
// §7's location_update message).
// inboundMsg は認証後にクライアントからサーバーへ送られるフレームの形式
// （仕様書§7の location_update メッセージ）。
type inboundMsg struct {
	Type     string       `json:"type"`
	Kind     session.Kind `json:"kind"`
	Lat      float64      `json:"lat"`
	Lng      float64      `json:"lng"`
	Accuracy float64      `json:"accuracy"`
}

// syncPayload is the initial "sync" frame sent right after Join succeeds,
// giving the client the full current state of the session.
// syncPayload は Join 成功直後に送られる初回の "sync" フレームで、
// クライアントへセッションの現在の完全な状態を渡す。
type syncPayload struct {
	Type       string                 `json:"type"`
	Role       session.Role           `json:"role"`
	ExpiresAt  time.Time              `json:"expiresAt"`
	Target     session.LocationState  `json:"target"`
	LiveA      *session.LocationState `json:"liveA,omitempty"`
	LiveB      *session.LocationState `json:"liveB,omitempty"`
	PeerOnline bool                   `json:"peerOnline"`
}

// serve は /ws への接続1本ぶんの処理全体を担う。
// 1. HTTP から WebSocket へアップグレード
// 2. 認証フレームの受信とセッションへの参加（hub.Join）
// 3. 初回同期（sync）フレームの送信
// 4. 位置情報更新メッセージを受信し続けるループ
// 5. 切断時のクリーンアップ（hub.Disconnect）
func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	// 1. WebSocket へアップグレードする。
	wsConn, err := upgrader.Upgrade(w, r, nil)
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
	rec, role, peerOnline, err := h.hub.Join(ctx, auth.SessionID, auth.Token, conn)
	if err != nil {
		_ = conn.Send(map[string]string{"type": "error", "message": "session not found or expired"})
		return
	}

	// 3. 現在のセッション状態をまとめて送り、クライアントを同期させる。
	if err := conn.Send(syncPayload{
		Type:       "sync",
		Role:       role,
		ExpiresAt:  rec.ExpiresAt,
		Target:     rec.LocATarget,
		LiveA:      rec.LocALive,
		LiveB:      rec.LocBLive,
		PeerOnline: peerOnline,
	}); err != nil {
		h.hub.Disconnect(auth.SessionID, role, conn)
		return
	}

	// 4. 接続が切れるまで location_update メッセージを受信し続ける。
	for {
		var msg inboundMsg
		if err := wsConn.ReadJSON(&msg); err != nil {
			break
		}
		if msg.Type != "location_update" {
			continue
		}
		loc := session.LocationState{
			Lat:       msg.Lat,
			Lng:       msg.Lng,
			Accuracy:  msg.Accuracy,
			UpdatedAt: time.Now().UTC(),
		}
		if err := h.hub.UpdateLocation(ctx, auth.SessionID, role, msg.Kind, loc); err != nil {
			h.log.Warn("rejected location update", "session", auth.SessionID, "role", role, "err", err)
		}
	}

	// 5. 読み取りループを抜けた（＝接続が切れた）ので後始末する。
	h.hub.Disconnect(auth.SessionID, role, conn)
}
