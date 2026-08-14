// Package hub is the in-memory heart of cocode: it tracks every live
// session's WebSocket connections and broadcasts location updates between
// the two participants. It intentionally has no notion of HTTP or
// WebSocket framing — session.Store handles persistence and the ws/api
// packages handle transport, so this package can be tested in isolation.
//
// cocode deploys with Cloud Run max-instances=1 (spec §3) specifically so
// this single process-wide map is enough to route broadcasts without an
// external pub/sub store like Redis.
//
// hub パッケージは cocode のインメモリ処理の中核であり、
// 全ての稼働中セッションの WebSocket コネクションを管理し、
// 二人の参加者の間で位置情報の更新をブロードキャストする。
// HTTP や WebSocket のフレーミングは意図的に扱わない
// （永続化は session.Store、通信は ws/api パッケージが担当するため、
// このパッケージ単体でテストできるようになっている）。
//
// cocode は Cloud Run の max-instances=1 でデプロイされる（仕様書§3）ため、
// プロセス内のこの単一マップだけで、Redis のような外部 pub/sub ストアなしに
// ブロードキャストを配信できる。
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
// Conn は hub が接続中のブラウザへイベントを送るために必要な、
// トランスポート層コネクションの最小限のインターフェース。ws.Conn がこれを実装する。
type Conn interface {
	Send(v any) error
	Close() error
}

// Event type strings, matching the WebSocket protocol in spec §7.
// イベント種別の文字列定数。仕様書§7の WebSocket プロトコルに対応する。
const (
	EventPeerLocation = "peer_location"
	EventPeerJoined   = "peer_joined"
	EventPeerLeft     = "peer_left"
	EventSessionEnded = "session_ended"
	EventSessionExp   = "session_expired"
)

// 各イベントの JSON ペイロード定義。
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

// room は1つの稼働中セッションのメモリ上の状態
// （セッション本体・A/B双方のコネクション・失効タイマー）を保持する。
type room struct {
	mu    sync.Mutex
	rec   *session.Record
	connA Conn
	connB Conn
	timer *time.Timer
}

// connFor は role に対応するコネクションを返す（未接続なら nil）。
func (r *room) connFor(role session.Role) Conn {
	if role == session.RoleA {
		return r.connA
	}
	return r.connB
}

// setConn は role に対応するコネクションを設定する。
func (r *room) setConn(role session.Role, c Conn) {
	if role == session.RoleA {
		r.connA = c
	} else {
		r.connB = c
	}
}

// Manager owns every live session room for this process.
// Manager はこのプロセス上の全ての稼働中セッション（room）を所有・管理する。
type Manager struct {
	store session.Store
	ttl   time.Duration
	log   *slog.Logger

	mu    sync.Mutex
	rooms map[string]*room
}

// NewManager は Manager を生成する。
func NewManager(store session.Store, ttl time.Duration, log *slog.Logger) *Manager {
	return &Manager{store: store, ttl: ttl, log: log, rooms: make(map[string]*room)}
}

// newRoom builds a room for rec and arms its TTL expiry timer, which calls
// m.expire(id) once the session's ExpiresAt is reached. Shared by Create
// (brand-new sessions) and getOrLoad (sessions hydrated from Postgres).
// newRoom は rec から room を構築し、有効期限に到達したら m.expire(id) を
// 呼び出す失効タイマーを起動する。Create（新規作成時）と
// getOrLoad（Postgres からの復元時）の両方で共用する。
func (m *Manager) newRoom(rec *session.Record) *room {
	id := rec.ID
	return &room{
		rec:   rec,
		timer: time.AfterFunc(time.Until(rec.ExpiresAt), func() { m.expire(id) }),
	}
}

// Create persists a brand new session — the meeting point is mandatory
// (spec §5.1) so a share link only ever exists once A has set one — and
// starts tracking it in memory with its 30-minute expiry timer.
// Create は新しいセッションを永続化する。待ち合わせ地点は必須項目であり
// （仕様書§5.1）、A がそれを設定して初めて共有リンクが存在しうる。
// 併せて、デフォルト30分の失効タイマー付きでメモリ上の追跡も開始する。
func (m *Manager) Create(ctx context.Context, target session.LocationState) (*session.Record, error) {
	// A/B それぞれの認証トークンを発行する。
	tokenA, err := session.NewToken()
	if err != nil {
		return nil, err
	}
	tokenB, err := session.NewToken()
	if err != nil {
		return nil, err
	}

	// まず DB に永続化し、DB 採番の id を含むレコードを受け取る。
	rec, err := m.store.Insert(ctx, tokenA, tokenB, m.ttl, target)
	if err != nil {
		return nil, err
	}

	// メモリ上にも room を作成して以後の接続・更新を扱えるようにする。
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms[rec.ID] = m.newRoom(rec)
	return rec, nil
}

// getOrLoad returns the in-memory room for id, hydrating it from Postgres
// if this process doesn't have it yet (e.g. right after a cold start).
// Sessions found to be already past their TTL are deleted and reported as
// not-found — this is the "safety net" lazy check from spec §5.5/§6 that
// stands in for a periodic cleanup job.
// getOrLoad は id に対応するメモリ上の room を返す。プロセスがまだ
// それを持っていない場合（コールドスタート直後など）は Postgres から復元する。
// 既に TTL を過ぎているセッションは削除した上で「見つからない」として扱う。
// これは定期クリーンアップジョブの代わりとなる、仕様書§5.5/§6の
// 「安全網」的な遅延チェックである。
func (m *Manager) getOrLoad(ctx context.Context, id string) (*room, error) {
	// まずメモリ上のキャッシュを確認する。
	m.mu.Lock()
	r, ok := m.rooms[id]
	m.mu.Unlock()
	if ok {
		return r, nil
	}

	// メモリに無ければ DB から読み込む。
	rec, err := m.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if rec.Expired(time.Now()) {
		_ = m.store.Delete(ctx, id)
		return nil, session.ErrNotFound
	}

	// 復元した room をキャッシュに登録する。他の goroutine が
	// 先に復元済みの場合はそちらを優先し、二重登録を避ける。
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.rooms[id]; ok {
		return existing, nil // another goroutine hydrated it first
	}
	r = m.newRoom(rec)
	m.rooms[id] = r
	return r, nil
}

// GetState returns a snapshot of the session for the given token, backing
// GET /api/sessions/:id/state (spec §7).
// GetState は指定トークンに対するセッションのスナップショットを返す。
// GET /api/sessions/:id/state（仕様書§7）の実処理を担う。
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
// Join は指定トークンに対応する WebSocket コネクションをセッションへ結びつける。
// 同じ role の既存コネクションがあれば置き換える。戻り値には、相手が
// 既に接続済みかどうか（UI の「オンライン」表示の初期値、仕様書§9）も含む。
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
	// 同じ role の古いコネクションが残っていれば閉じてから差し替える。
	if prev := r.connFor(role); prev != nil {
		_ = prev.Close()
	}
	r.setConn(role, conn)
	recCopy := *r.rec
	peer := r.connFor(otherRole(role))
	peerOnline = peer != nil
	r.mu.Unlock()

	// 相手が接続中であれば「参加した」ことを通知する。
	if peer != nil {
		_ = peer.Send(roleEventMsg{Type: EventPeerJoined, Role: role})
	}

	return &recCopy, role, peerOnline, nil
}

// Disconnect detaches a connection once its socket closes. The session
// itself is untouched — only an explicit "end" or TTL expiry deletes it,
// so a dropped connection alone never destroys the meeting point.
// Disconnect はソケットが閉じた際にコネクションをセッションから切り離す。
// セッション自体は削除しない。明示的な「終了」または TTL 失効のみが
// セッションを削除するため、コネクションが切れただけでは
// 待ち合わせ地点などの情報は失われない。
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
// UpdateLocation は location_update メッセージ（仕様書§7）を反映する。
// kind="target"（待ち合わせ地点）は role A のみ設定可能
// （仕様書§8-8、なりすまし防止のガード）。kind="live" は双方から受け付ける。
// 更新内容は永続化した上で相手側へブロードキャストする。
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

	// メモリ上の状態を即座に更新する（ブロードキャストの元データ）。
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
		// メモリ上の状態（＝ライブ配信の内容）は既に正しく、次回の更新で
		// 古い DB の行はどのみち上書きされるため、永続化の失敗だけで
		// ライブ更新自体を失敗扱いにはしない。
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
// End は明示的な「終了」操作（仕様書§5.5）を実装する。
// どちらの側からでもセッションを即座に終了させ、削除の上、双方を切断できる。
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

// expire は失効タイマー発火時に呼ばれ、TTL 切れとしてセッションを片付ける。
func (m *Manager) expire(id string) {
	m.teardown(context.Background(), id, EventSessionExp, "ttl")
}

// teardown deletes the session from Postgres, notifies any connected
// clients and removes the room from memory. It is the single exit path
// shared by explicit end and TTL expiry.
// teardown は Postgres からセッションを削除し、接続中のクライアントへ通知した上で
// メモリ上の room を取り除く。明示的終了と TTL 失効の両方が通る唯一の終了経路。
func (m *Manager) teardown(ctx context.Context, id, eventType, reason string) {
	// メモリ上から room を取り除き、タイマーを止めてコネクションを取得する。
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

	// DB からも削除する。
	if err := m.store.Delete(ctx, id); err != nil && m.log != nil {
		m.log.Error("delete session failed", "session", id, "err", err)
	}

	// 接続中の両クライアントへ終了イベントを送り、コネクションを閉じる。
	msg := reasonEventMsg{Type: eventType, Reason: reason}
	for _, c := range []Conn{connA, connB} {
		if c == nil {
			continue
		}
		_ = c.Send(msg)
		_ = c.Close()
	}
}

// otherRole は与えられた role の「相手側」の role を返す。
func otherRole(r session.Role) session.Role {
	if r == session.RoleA {
		return session.RoleB
	}
	return session.RoleA
}
