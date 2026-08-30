// hub パッケージは cocode のインメモリ処理の中核であり、
// 全ての稼働中セッションの WebSocket コネクションを管理し、
// ホスト1人+ゲストN人（最大20人、仕様書§5.2）の参加者間で
// 位置情報の更新をブロードキャストする。
// HTTP や WebSocket のフレーミングは意図的に扱わない
// （永続化は session.Store、通信は ws/api パッケージが担当するため、
// このパッケージ単体でテストできるようになっている）。
//
// cocode は Cloud Run の max-instances=1 でデプロイされる（仕様書§5.7）ため、
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

// Conn は hub が接続中のブラウザへイベントを送るために必要な、
// トランスポート層コネクションの最小限のインターフェース。ws.Conn がこれを実装する。
type Conn interface {
	Send(v any) error
	Close() error
}

// イベント種別の文字列定数（仕様書§5.4）。
const (
	EventPeerLocation       = "peer_location"
	EventParticipantJoined  = "participant_joined"
	EventParticipantLeft    = "participant_left"
	EventParticipantUpdated = "participant_updated"
	EventSessionEnded       = "session_ended"
	EventSessionExpired     = "session_expired"
)

// ProfileUpdateCooldown は同一参加者からの profile_update を受け付ける最短間隔
// （乱用対策、仕様書§14.5。§12.1のexpressionクールダウンと同じ考え方）。
const ProfileUpdateCooldown = 5 * time.Second

// participantSummary は participant_joined ブロードキャストに乗せる、
// 新規参加者の公開情報（仕様書§5.4）。sync フレーム用のより詳細な表現
// （ライブ位置・ETA込み）は ws パッケージ側の participantPublic が別途持つ。
type participantSummary struct {
	ID            string                `json:"id"`
	Role          session.Role          `json:"role"`
	DisplayName   string                `json:"displayName"`
	AvatarIcon    string                `json:"avatarIcon"`
	TransportMode session.TransportMode `json:"transportMode"`
}

type peerLocationMsg struct {
	Type          string       `json:"type"`
	ParticipantID string       `json:"participantId"`
	Role          session.Role `json:"role"`
	DisplayName   string       `json:"displayName"`
	AvatarIcon    string       `json:"avatarIcon"`
	Kind          session.Kind `json:"kind"`
	Lat           float64      `json:"lat"`
	Lng           float64      `json:"lng"`
	Accuracy      float64      `json:"accuracy,omitempty"`
	Address       string       `json:"address,omitempty"`
	UpdatedAt     time.Time    `json:"updatedAt"`
}

type participantJoinedMsg struct {
	Type        string             `json:"type"`
	Participant participantSummary `json:"participant"`
}

type participantLeftMsg struct {
	Type          string `json:"type"`
	ParticipantID string `json:"participantId"`
	DisplayName   string `json:"displayName"`
}

type participantUpdatedMsg struct {
	Type          string    `json:"type"`
	ParticipantID string    `json:"participantId"`
	DisplayName   string    `json:"displayName"`
	AvatarIcon    string    `json:"avatarIcon"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type reasonEventMsg struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// room は1つの稼働中セッションのメモリ上の状態を保持する。
// v1の connA/connB 固定フィールドを、participantId をキーにした map に置き換える
// （仕様書§5.4、不具合修正§0の土台）。
type room struct {
	mu              sync.Mutex
	rec             *session.Record
	participants    map[string]*session.Participant // participantId -> メタ情報のキャッシュ
	conns           map[string]Conn                 // participantId -> 接続中のコネクション（未接続なら不在）
	profileCooldown map[string]time.Time            // participantId -> 直近の profile_update 時刻（仕様書§14.5）
	timer           *time.Timer
}

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

// newRoom は rec + 参加者一覧から room を構築し、有効期限に到達したら
// m.expire(id) を呼び出す失効タイマーを起動する。Create（新規作成時）と
// getOrLoad（Postgres からの復元時）の両方で共用する。
func (m *Manager) newRoom(rec *session.Record, participants []*session.Participant) *room {
	id := rec.ID
	pm := make(map[string]*session.Participant, len(participants))
	for _, p := range participants {
		pm[p.ID] = p
	}
	return &room{
		rec:             rec,
		participants:    pm,
		conns:           make(map[string]Conn),
		profileCooldown: make(map[string]time.Time),
		timer:           time.AfterFunc(time.Until(rec.ExpiresAt), func() { m.expire(id) }),
	}
}

// Create はホスト用にセッションを新規作成する（目的地は必須、仕様書§5.1）。
// 併せて、メモリ上にも room を作成し以後の接続・更新を扱えるようにする。
func (m *Manager) Create(ctx context.Context, destLat, destLng float64, destAddress, hostDisplayName, hostAvatarIcon string) (*session.Record, *session.Participant, error) {
	// ホスト/ゲストそれぞれの認証トークンを発行する。
	tokenHost, err := session.NewToken()
	if err != nil {
		return nil, nil, err
	}
	tokenGuest, err := session.NewToken()
	if err != nil {
		return nil, nil, err
	}

	rec, host, err := m.store.InsertWithHost(ctx, tokenHost, tokenGuest, m.ttl, destLat, destLng, destAddress, hostDisplayName, hostAvatarIcon)
	if err != nil {
		return nil, nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.rooms[rec.ID] = m.newRoom(rec, []*session.Participant{host})
	return rec, host, nil
}

// getOrLoad は id に対応するメモリ上の room を返す。プロセスがまだ
// それを持っていない場合（コールドスタート直後など）は Postgres から復元する。
// 既に TTL を過ぎているセッションは削除した上で「見つからない」として扱う。
// これは定期クリーンアップジョブの代わりとなる、仕様書の「安全網」的な遅延チェックである。
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
	participants, err := m.store.ListParticipants(ctx, id)
	if err != nil {
		return nil, err
	}

	// 復元した room をキャッシュに登録する。他の goroutine が
	// 先に復元済みの場合はそちらを優先し、二重登録を避ける。
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.rooms[id]; ok {
		return existing, nil
	}
	r = m.newRoom(rec, participants)
	m.rooms[id] = r
	return r, nil
}

// GetState は REST の GET /api/sessions/:id/state を支える。
// ホストトークンなら常にホスト参加者自身の情報を返す。ゲストトークンで
// participantId が空の場合は self=nil を返し、参加者登録は行わない
// （初回ゲストが開くゲスト用トップページ向けのプレビュー、仕様書§5.5・§14.2。
// 呼び出し元は self==nil の場合、rec と len(all) のみを使い、all の個々の
// 要素（他参加者の表示名・位置情報）はレスポンスに含めないこと）。
func (m *Manager) GetState(ctx context.Context, sessionID, token, participantID string) (rec *session.Record, self *session.Participant, all []*session.Participant, err error) {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return nil, nil, nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	role, ok := r.rec.RoleForToken(token)
	if !ok {
		return nil, nil, nil, session.ErrNotFound
	}

	recCopy := *r.rec
	allSnapshot := snapshotParticipants(r)

	if role == session.RoleHost {
		return &recCopy, hostParticipant(r), allSnapshot, nil
	}

	// role == session.RoleGuest
	if participantID == "" {
		return &recCopy, nil, allSnapshot, nil
	}
	p, ok := r.participants[participantID]
	if !ok || p.Role != session.RoleGuest {
		return nil, nil, nil, session.ErrNotFound
	}
	return &recCopy, p, allSnapshot, nil
}

// Join はWS接続をセッションへ結びつける。ホストトークンなら常に既存のホスト
// 参加者に再接続する。ゲストトークンは participantId があれば再接続、無ければ
// 新規参加者を作成する（displayName/avatarIcon必須、上限到達時は
// session.ErrParticipantLimit）。戻り値の all には self を含む、その時点の
// 全参加者のスナップショットを返す（sync ペイロード用）。
func (m *Manager) Join(ctx context.Context, sessionID, token, participantID, displayName, avatarIcon string, conn Conn) (rec *session.Record, self *session.Participant, all []*session.Participant, err error) {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return nil, nil, nil, err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return nil, nil, nil, session.ErrNotFound
	}

	isNewGuest := false
	switch role {
	case session.RoleHost:
		self = hostParticipant(r)
		if self == nil {
			r.mu.Unlock()
			return nil, nil, nil, session.ErrNotFound
		}
	case session.RoleGuest:
		if participantID != "" {
			p, ok := r.participants[participantID]
			if !ok || p.Role != session.RoleGuest {
				r.mu.Unlock()
				return nil, nil, nil, session.ErrNotFound
			}
			self = p
		} else {
			if !session.ValidDisplayName(displayName) || !session.ValidAvatarIcon(avatarIcon) {
				r.mu.Unlock()
				return nil, nil, nil, session.ErrForbidden
			}
			if len(r.participants) >= session.MaxParticipants {
				r.mu.Unlock()
				return nil, nil, nil, session.ErrParticipantLimit
			}
			r.mu.Unlock()
			// INSERT(DB I/O)はroomのロックを持ったまま行わない。
			// 参加人数上限は store.InsertParticipant 側でも再チェックされる
			// （こちらは同時参加のごく稀な競合に対する最終防衛線）。
			newP, insErr := m.store.InsertParticipant(ctx, sessionID, displayName, avatarIcon)
			if insErr != nil {
				return nil, nil, nil, insErr
			}
			r.mu.Lock()
			r.participants[newP.ID] = newP
			self = newP
			isNewGuest = true
		}
	}

	// 同じ participantId の古いコネクションが残っていれば閉じてから差し替える。
	if prev, ok := r.conns[self.ID]; ok && prev != nil {
		_ = prev.Close()
	}
	r.conns[self.ID] = conn
	recCopy := *r.rec
	allSnapshot := snapshotParticipants(r)
	peers := otherConns(r, self.ID)
	r.mu.Unlock()

	// 新規ゲストの参加のみ他参加者へ通知する（再接続時は通知しない）。
	if isNewGuest {
		msg := participantJoinedMsg{
			Type: EventParticipantJoined,
			Participant: participantSummary{
				ID:            self.ID,
				Role:          self.Role,
				DisplayName:   self.DisplayName,
				AvatarIcon:    self.AvatarIcon,
				TransportMode: self.TransportMode,
			},
		}
		for _, c := range peers {
			_ = c.Send(msg)
		}
	}

	return &recCopy, self, allSnapshot, nil
}

// Disconnect はソケットが閉じた際にコネクションをセッションから切り離す。
// 参加者情報（displayName等）自体は削除しない — 再接続に備えるため。
// 他の接続中参加者全員へ participant_left をブロードキャストする
// （不具合修正§0: v1では固定の1名にしか送っていなかった）。
func (m *Manager) Disconnect(sessionID, participantID string, conn Conn) {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	if r.conns[participantID] != conn {
		r.mu.Unlock()
		return // 既に新しいコネクションに置き換わっている場合
	}
	delete(r.conns, participantID)
	displayName := ""
	if p, ok := r.participants[participantID]; ok {
		displayName = p.DisplayName
	}
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	msg := participantLeftMsg{Type: EventParticipantLeft, ParticipantID: participantID, DisplayName: displayName}
	for _, c := range peers {
		_ = c.Send(msg)
	}
}

// UpdateLocation は location_update メッセージ（仕様書§5.4）を反映する。
// kind="target"（目的地）はロールがホストの参加者のみ設定可能
// （なりすまし防止、仕様書§8-8を踏襲）。kind="live" は全ロール許可。
// 更新内容は永続化した上で、他の接続中参加者全員へブロードキャストする。
func (m *Manager) UpdateLocation(ctx context.Context, sessionID, participantID string, kind session.Kind, loc session.LocationState, address string) error {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return session.ErrNotFound
	}

	r.mu.Lock()
	self, ok := r.participants[participantID]
	if !ok {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	if kind == session.KindTarget && self.Role != session.RoleHost {
		r.mu.Unlock()
		return fmt.Errorf("role %s may not set the destination", self.Role)
	}

	switch kind {
	case session.KindTarget:
		r.rec.DestLat, r.rec.DestLng, r.rec.DestAddress, r.rec.DestUpdatedAt = loc.Lat, loc.Lng, address, loc.UpdatedAt
	case session.KindLive:
		locCopy := loc
		self.Live = &locCopy
	}
	role, displayName, avatarIcon := self.Role, self.DisplayName, self.AvatarIcon
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	var persistErr error
	switch kind {
	case session.KindTarget:
		persistErr = m.store.UpdateTarget(ctx, sessionID, loc.Lat, loc.Lng, address, loc.UpdatedAt)
	case session.KindLive:
		persistErr = m.store.UpdateParticipantLive(ctx, participantID, loc)
	}
	if persistErr != nil && m.log != nil {
		// メモリ上の状態（＝ライブ配信の内容）は既に正しく、次回の更新で
		// 古い DB の行はどのみち上書きされるため、永続化の失敗だけで
		// ライブ更新自体を失敗扱いにはしない（v1からの方針を踏襲）。
		m.log.Error("persist location update failed", "session", sessionID, "participant", participantID, "err", persistErr)
	}

	msg := peerLocationMsg{
		Type:          EventPeerLocation,
		ParticipantID: participantID,
		Role:          role,
		DisplayName:   displayName,
		AvatarIcon:    avatarIcon,
		Kind:          kind,
		Lat:           loc.Lat,
		Lng:           loc.Lng,
		Accuracy:      loc.Accuracy,
		Address:       address,
		UpdatedAt:     loc.UpdatedAt,
	}
	for _, c := range peers {
		_ = c.Send(msg)
	}
	return nil
}

// UpdateProfile は profile_update メッセージ（仕様書§14.5）を反映する。
// 共有中でも表示名・アイコンをいつでも変更できるが、乱用防止のため
// 参加者ごとに ProfileUpdateCooldown 間隔でのみ受け付ける。
func (m *Manager) UpdateProfile(ctx context.Context, sessionID, participantID, displayName, avatarIcon string) error {
	if !session.ValidDisplayName(displayName) || !session.ValidAvatarIcon(avatarIcon) {
		return session.ErrForbidden
	}

	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return session.ErrNotFound
	}

	r.mu.Lock()
	self, ok := r.participants[participantID]
	if !ok {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	if last, ok := r.profileCooldown[participantID]; ok && time.Since(last) < ProfileUpdateCooldown {
		r.mu.Unlock()
		return session.ErrRateLimited
	}
	r.profileCooldown[participantID] = time.Now()
	self.DisplayName = displayName
	self.AvatarIcon = avatarIcon
	updatedAt := time.Now().UTC()
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	if err := m.store.UpdateParticipantProfile(ctx, participantID, displayName, avatarIcon); err != nil && m.log != nil {
		// 位置情報更新時と同じ方針: メモリ上の状態は既に正しく、次回の更新で
		// どのみち上書きされるため、永続化の失敗だけで操作自体を失敗扱いにはしない。
		m.log.Error("persist profile update failed", "session", sessionID, "participant", participantID, "err", err)
	}

	msg := participantUpdatedMsg{
		Type:          EventParticipantUpdated,
		ParticipantID: participantID,
		DisplayName:   displayName,
		AvatarIcon:    avatarIcon,
		UpdatedAt:     updatedAt,
	}
	for _, c := range peers {
		_ = c.Send(msg)
	}
	return nil
}

// End は明示的な「終了」操作を実装する。ホストトークンのみ受理し、
// 全参加者を切断・削除する（仕様書§5.6）。ゲストトークンは session.ErrForbidden。
func (m *Manager) End(ctx context.Context, sessionID, token string) error {
	rec, err := m.recordFor(ctx, sessionID)
	if err != nil {
		return err
	}
	role, ok := rec.RoleForToken(token)
	if !ok {
		return session.ErrNotFound
	}
	if role != session.RoleHost {
		return session.ErrForbidden
	}

	m.teardown(ctx, sessionID, EventSessionEnded, "manual")
	return nil
}

// recordFor はメモリ上の room があればそこから、無ければ Postgres から
// セッション本体だけを取得する（End のトークン検証用）。
func (m *Manager) recordFor(ctx context.Context, sessionID string) (*session.Record, error) {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if ok {
		r.mu.Lock()
		defer r.mu.Unlock()
		recCopy := *r.rec
		return &recCopy, nil
	}
	return m.store.Get(ctx, sessionID)
}

// expire は失効タイマー発火時に呼ばれ、TTL 切れとしてセッションを片付ける。
func (m *Manager) expire(id string) {
	m.teardown(context.Background(), id, EventSessionExpired, "ttl")
}

// teardown は Postgres からセッションを削除し、接続中の全クライアントへ通知した
// 上でメモリ上の room を取り除く。明示的終了と TTL 失効の両方が通る唯一の終了経路。
func (m *Manager) teardown(ctx context.Context, sessionID, eventType, reason string) {
	// メモリ上から room を取り除き、タイマーを止めて接続中の全コネクションを集める。
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	delete(m.rooms, sessionID)
	m.mu.Unlock()

	var conns []Conn
	if ok {
		r.mu.Lock()
		if r.timer != nil {
			r.timer.Stop()
		}
		for _, c := range r.conns {
			conns = append(conns, c)
		}
		r.mu.Unlock()
	}

	// DB からも削除する。
	if err := m.store.Delete(ctx, sessionID); err != nil && m.log != nil {
		m.log.Error("delete session failed", "session", sessionID, "err", err)
	}

	// 接続中の全クライアントへ終了イベントを送り、コネクションを閉じる。
	msg := reasonEventMsg{Type: eventType, Reason: reason}
	for _, c := range conns {
		_ = c.Send(msg)
		_ = c.Close()
	}
}

// hostParticipant は room 内のホスト参加者（常に1人存在するはず、仕様書§5.1）を返す。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func hostParticipant(r *room) *session.Participant {
	for _, p := range r.participants {
		if p.Role == session.RoleHost {
			return p
		}
	}
	return nil
}

// snapshotParticipants は room.participants の値スライスのコピーを返す。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func snapshotParticipants(r *room) []*session.Participant {
	out := make([]*session.Participant, 0, len(r.participants))
	for _, p := range r.participants {
		pCopy := *p
		out = append(out, &pCopy)
	}
	return out
}

// otherConns は participantID 以外の、接続中の全コネクションを返す。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func otherConns(r *room, participantID string) []Conn {
	out := make([]Conn, 0, len(r.conns))
	for id, c := range r.conns {
		if id == participantID || c == nil {
			continue
		}
		out = append(out, c)
	}
	return out
}
