// Package ws implements cocode's realtime transport: the /ws endpoint that
// both participants hold open for the life of a session, streaming live
// location updates in both directions (spec §4, §7).
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
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Conn adapts a gorilla websocket connection to hub.Conn. It serializes
// writes with a mutex because gorilla forbids concurrent writers, and the
// hub broadcasts from a different goroutine than this connection's own
// read loop.
type Conn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *Conn) Send(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(v)
}

func (c *Conn) Close() error {
	return c.ws.Close()
}

var _ hub.Conn = (*Conn)(nil)

type Handler struct {
	hub *hub.Manager
	log *slog.Logger
}

func NewHandler(h *hub.Manager, log *slog.Logger) *Handler {
	return &Handler{hub: h, log: log}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", h.serve)
}

// authFrame is the first message a client must send right after the
// upgrade, carrying the session id and token. Keeping these out of the
// query string keeps them out of Cloud Run's access logs (spec §8-2).
type authFrame struct {
	SessionID string `json:"sessionId"`
	Token     string `json:"token"`
}

// inboundMsg is the shape of every client->server frame after auth (spec
// §7's location_update message).
type inboundMsg struct {
	Type     string       `json:"type"`
	Kind     session.Kind `json:"kind"`
	Lat      float64      `json:"lat"`
	Lng      float64      `json:"lng"`
	Accuracy float64      `json:"accuracy"`
}

type syncPayload struct {
	Type       string                 `json:"type"`
	Role       session.Role           `json:"role"`
	ExpiresAt  time.Time              `json:"expiresAt"`
	Target     session.LocationState  `json:"target"`
	LiveA      *session.LocationState `json:"liveA,omitempty"`
	LiveB      *session.LocationState `json:"liveB,omitempty"`
	PeerOnline bool                   `json:"peerOnline"`
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Warn("ws upgrade failed", "err", err)
		return
	}
	conn := &Conn{ws: wsConn}
	defer wsConn.Close()

	// The very first frame must be the auth handshake; give the client a
	// short window to send it before giving up on an idle connection.
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

	h.hub.Disconnect(auth.SessionID, role, conn)
}
