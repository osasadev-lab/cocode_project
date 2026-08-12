// Package hub is the in-memory heart of cocode: it tracks every live
// session's WebSocket connections and broadcasts location updates between
// the two participants. It intentionally has no notion of HTTP or
// WebSocket framing — session.Store handles persistence and the ws/api
// packages handle transport, so this package can be tested in isolation.
//
// cocode deploys with Cloud Run max-instances=1 (spec §3) specifically so
// this single process-wide map is enough to route broadcasts without an
// external pub/sub store like Redis.
package hub

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

// Conn is the minimal surface the hub needs from a transport connection to
// push events to a connected browser. ws.Conn implements this.
type Conn interface {
	Send(v any) error
	Close() error
}

// Event type strings, matching the WebSocket protocol in spec §7.
const (
	EventPeerLocation = "peer_location"
	EventPeerJoined   = "peer_joined"
	EventPeerLeft     = "peer_left"
	EventSessionEnded = "session_ended"
	EventSessionExp   = "session_expired"
)

type peerLocationMsg struct {
	Type      string       `json:"type"`
	Role      session.Role `json:"role"`
	Kind      session.Kind `json:"kind"`
	Lat       float64      `json:"lat"`
	Lng       float64      `json:"lng"`
	Accuracy  float64      `json:"accuracy,omitempty"`
	UpdatedAt time.Time    `json:"updatedAt"`
}

type roleEventMsg struct {
	Type string       `json:"type"`
	Role session.Role `json:"role"`
}

type reasonEventMsg struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

type room struct {
	mu    sync.Mutex
	rec   *session.Record
	connA Conn
	connB Conn
	timer *time.Timer
}

func (r *room) connFor(role session.Role) Conn {
	if role == session.RoleA {
		return r.connA
	}
	return r.connB
}

func (r *room) setConn(role session.Role, c Conn) {
	if role == session.RoleA {
		r.connA = c
	} else {
		r.connB = c
	}
}

// Manager owns every live session room for this process.
type Manager struct {
	store session.Store
	ttl   time.Duration
	log   *slog.Logger

	mu    sync.Mutex
	rooms map[string]*room
}

func NewManager(store session.Store, ttl time.Duration, log *slog.Logger) *Manager {
	return &Manager{store: store, ttl: ttl, log: log, rooms: make(map[string]*room)}
}

// Create persists a brand new session — the meeting point is mandatory
// (spec §5.1) so a share link only ever exists once A has set one — and
// starts tracking it in memory with its 30-minute expiry timer.
func (m *Manager) Create(ctx context.Context, target session.LocationState) (*session.Record, error) {
	tokenA, err := session.NewToken()
	if err != nil {
		return nil, err
	}
	tokenB, err := session.NewToken()
	if err != nil {
		return nil, err
	}

	rec, err := m.store.Insert(ctx, tokenA, tokenB, m.ttl, target)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	id := rec.ID
	m.rooms[id] = &room{
		rec:   rec,
		timer: time.AfterFunc(time.Until(rec.ExpiresAt), func() { m.expire(id) }),
	}
	return rec, nil
}

// getOrLoad returns the in-memory room for id, hydrating it from Postgres
// if this process doesn't have it yet (e.g. right after a cold start).
// Sessions found to be already past their TTL are deleted and reported as
// not-found — this is the "safety net" lazy check from spec §5.5/§6 that
// stands in for a periodic cleanup job.
func (m *Manager) getOrLoad(ctx context.Context, id string) (*room, error) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	m.mu.Unlock()
	if ok {
		return r, nil
	}

	rec, err := m.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if rec.Expired(time.Now()) {
		_ = m.store.Delete(ctx, id)
		return nil, session.ErrNotFound
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.rooms[id]; ok {
		return existing, nil // another goroutine hydrated it first
	}
	r = &room{
		rec:   rec,
		timer: time.AfterFunc(time.Until(rec.ExpiresAt), func() { m.expire(id) }),
	}
	m.rooms[id] = r
	return r, nil
}

// GetState returns a snapshot of the session for the given token, backing
// GET /api/sessions/:id/state (spec §7).
func (m *Manager) GetState(ctx context.Context, id, token string) (*session.Record, session.Role, error) {
	r, err := m.getOrLoad(ctx, id)
	if err != nil {
		return nil, "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		return nil, "", session.ErrNotFound
	}
	recCopy := *r.rec
	return &recCopy, role, nil
}

// Join attaches a WebSocket connection to a session for the given token,
// replacing any previous connection held for that role, and returns a
// snapshot plus whether the other participant is already connected — the
// initial value for the "online" status the UI card shows (spec §9).
func (m *Manager) Join(ctx context.Context, id, token string, conn Conn) (rec *session.Record, role session.Role, peerOnline bool, err error) {
	r, err := m.getOrLoad(ctx, id)
	if err != nil {
		return nil, "", false, err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return nil, "", false, session.ErrNotFound
	}
	if prev := r.connFor(role); prev != nil {
		_ = prev.Close()
	}
	r.setConn(role, conn)
	recCopy := *r.rec
	peer := r.connFor(otherRole(role))
	peerOnline = peer != nil
	r.mu.Unlock()

	if peer != nil {
		_ = peer.Send(roleEventMsg{Type: EventPeerJoined, Role: role})
	}

	return &recCopy, role, peerOnline, nil
}

// Disconnect detaches a connection once its socket closes. The session
// itself is untouched — only an explicit "end" or TTL expiry deletes it,
// so a dropped connection alone never destroys the meeting point.
func (m *Manager) Disconnect(id string, role session.Role, conn Conn) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	m.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	if r.connFor(role) != conn {
		r.mu.Unlock()
		return // already superseded by a newer connection
	}
	r.setConn(role, nil)
	peer := r.connFor(otherRole(role))
	r.mu.Unlock()

	if peer != nil {
		_ = peer.Send(roleEventMsg{Type: EventPeerLeft, Role: role})
	}
}

// UpdateLocation applies a location_update message (spec §7). kind="target"
// is only accepted from role A (spec §8-8, meeting-point spoof guard);
// kind="live" is accepted from both. The update is persisted and broadcast
// to the other participant.
func (m *Manager) UpdateLocation(ctx context.Context, id string, role session.Role, kind session.Kind, loc session.LocationState) error {
	if kind == session.KindTarget && role != session.RoleA {
		return fmt.Errorf("role %s may not set the meeting point", role)
	}

	m.mu.Lock()
	r, ok := m.rooms[id]
	m.mu.Unlock()
	if !ok {
		return session.ErrNotFound
	}

	r.mu.Lock()
	switch kind {
	case session.KindTarget:
		r.rec.LocATarget = loc
	case session.KindLive:
		if role == session.RoleA {
			r.rec.LocALive = &loc
		} else {
			r.rec.LocBLive = &loc
		}
	}
	peer := r.connFor(otherRole(role))
	r.mu.Unlock()

	if err := m.store.UpdateLocation(ctx, id, role, kind, loc); err != nil && m.log != nil {
		// The in-memory state (and thus the live broadcast) is already
		// correct, and the next update overwrites the stale DB row anyway,
		// so a persistence hiccup here shouldn't fail the live update.
		m.log.Error("persist location update failed", "session", id, "err", err)
	}

	if peer != nil {
		_ = peer.Send(peerLocationMsg{
			Type:      EventPeerLocation,
			Role:      role,
			Kind:      kind,
			Lat:       loc.Lat,
			Lng:       loc.Lng,
			Accuracy:  loc.Accuracy,
			UpdatedAt: loc.UpdatedAt,
		})
	}
	return nil
}

// End implements the explicit "終了" action (spec §5.5): either side may
// terminate the session immediately, deleting it and disconnecting both.
func (m *Manager) End(ctx context.Context, id, token string) error {
	m.mu.Lock()
	r, ok := m.rooms[id]
	m.mu.Unlock()

	var rec *session.Record
	if ok {
		r.mu.Lock()
		rec = r.rec
		r.mu.Unlock()
	} else {
		var err error
		rec, err = m.store.Get(ctx, id)
		if err != nil {
			return err
		}
	}
	if _, ok := rec.RoleForToken(token); !ok {
		return session.ErrNotFound
	}

	m.teardown(ctx, id, EventSessionEnded, "manual")
	return nil
}

func (m *Manager) expire(id string) {
	m.teardown(context.Background(), id, EventSessionExp, "ttl")
}

// teardown deletes the session from Postgres, notifies any connected
// clients and removes the room from memory. It is the single exit path
// shared by explicit end and TTL expiry.
func (m *Manager) teardown(ctx context.Context, id, eventType, reason string) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	delete(m.rooms, id)
	m.mu.Unlock()

	var connA, connB Conn
	if ok {
		r.mu.Lock()
		if r.timer != nil {
			r.timer.Stop()
		}
		connA, connB = r.connA, r.connB
		r.mu.Unlock()
	}

	if err := m.store.Delete(ctx, id); err != nil && m.log != nil {
		m.log.Error("delete session failed", "session", id, "err", err)
	}

	msg := reasonEventMsg{Type: eventType, Reason: reason}
	for _, c := range []Conn{connA, connB} {
		if c == nil {
			continue
		}
		_ = c.Send(msg)
		_ = c.Close()
	}
}

func otherRole(r session.Role) session.Role {
	if r == session.RoleA {
		return session.RoleB
	}
	return session.RoleA
}
