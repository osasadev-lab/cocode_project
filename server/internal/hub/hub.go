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
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"
	"unicode/utf8"

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
	EventParticipantArrived = "participant_arrived"
	EventSessionEnded       = "session_ended"
	EventSessionExpired     = "session_expired"
)

// ProfileUpdateCooldown は同一参加者からの profile_update を受け付ける最短間隔
// （乱用対策、仕様書§14.5。§12.1のexpressionクールダウンと同じ考え方）。
const ProfileUpdateCooldown = 5 * time.Second

// ExpressionCooldown は同一参加者からの expression を受け付ける最短間隔
// （乱用対策、仕様書§12.1）。
const ExpressionCooldown = 3 * time.Second

// MaxExpressionTextLength はスタンプのテキスト最大文字数(定型文からの選択を
// 想定しているが、サーバー側でも念のため上限を設ける)。
const MaxExpressionTextLength = 50

// arrivalRadiusMeters は到着とみなす目的地からの半径（仕様書§12.1-①、既定50m）。
const arrivalRadiusMeters = 50.0

// ReturnGracePeriod は接続が切れてから「画面に復帰しなかった」とみなすまでの
// 猶予時間（新設）。この時間内にJoin（再接続）すればタイマーはキャンセルされる。
// 復帰しなかった場合、ホストはセッション全体を終了し、ゲストはそのゲストのみを
// 個別退出させる。
const ReturnGracePeriod = 10 * time.Minute

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
	Type          string                `json:"type"`
	ParticipantID string                `json:"participantId"`
	Role          session.Role          `json:"role"`
	DisplayName   string                `json:"displayName"`
	AvatarIcon    string                `json:"avatarIcon"`
	Kind          session.Kind          `json:"kind"`
	Lat           float64               `json:"lat"`
	Lng           float64               `json:"lng"`
	Accuracy      float64               `json:"accuracy,omitempty"`
	Address       string                `json:"address,omitempty"`
	TransportMode session.TransportMode `json:"transportMode,omitempty"`
	ETASeconds    *int                  `json:"etaSeconds,omitempty"`
	RoutePolyline string                `json:"routePolyline,omitempty"`
	RouteSteps    json.RawMessage       `json:"routeSteps,omitempty"`
	UpdatedAt     time.Time             `json:"updatedAt"`
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

type participantArrivedMsg struct {
	Type          string    `json:"type"`
	ParticipantID string    `json:"participantId"`
	DisplayName   string    `json:"displayName"`
	ArrivedAt     time.Time `json:"arrivedAt"`
}

type peerExpressionMsg struct {
	Type          string    `json:"type"`
	ParticipantID string    `json:"participantId"`
	DisplayName   string    `json:"displayName"`
	AvatarIcon    string    `json:"avatarIcon"`
	Kind          string    `json:"kind"` // "stamp" | "reaction"
	Text          string    `json:"text,omitempty"`
	SentAt        time.Time `json:"sentAt"`
}

type reasonEventMsg struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// LiveExtras は kind="live" の location_update に付随する、移動手段・ETA・
// 経路情報（仕様書§7, §7.1.1）。kind="target"の呼び出しではゼロ値を渡す。
// サーバーはRoutePolyline/RouteStepsの中身を理解せず、そのままブロードキャスト
// に転記するだけ（保存もしない — DBに列を持たない一過性のデータ）。
type LiveExtras struct {
	TransportMode session.TransportMode
	ETASeconds    *int
	RoutePolyline string
	RouteSteps    json.RawMessage
}

// room は1つの稼働中セッションのメモリ上の状態を保持する。
// v1の connA/connB 固定フィールドを、participantId をキーにした map に置き換える
// （仕様書§5.4、不具合修正§0の土台）。
type room struct {
	mu                 sync.Mutex
	rec                *session.Record
	participants       map[string]*session.Participant // participantId -> メタ情報のキャッシュ
	conns              map[string]Conn                 // participantId -> 接続中のコネクション（未接続なら不在）
	profileCooldown    map[string]time.Time            // participantId -> 直近の profile_update 時刻（仕様書§14.5）
	expressionCooldown map[string]time.Time            // participantId -> 直近の expression 時刻（仕様書§12.1）
	returnTimers       map[string]*time.Timer          // participantId -> 復帰猶予タイマー（ReturnGracePeriod、新設）
	timer              *time.Timer
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
		rec:                rec,
		participants:       pm,
		conns:              make(map[string]Conn),
		profileCooldown:    make(map[string]time.Time),
		expressionCooldown: make(map[string]time.Time),
		returnTimers:       make(map[string]*time.Timer),
		timer:              time.AfterFunc(time.Until(rec.ExpiresAt), func() { m.expire(id) }),
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
//
// announceRejoin は、明示的に「退出する」した後、招待リンクから再び参加した
// ゲストの再接続かどうかをクライアント側の判断で伝えるフラグ（2026-09-01
// 新設）。通常の（ネットワーク瞬断からの）自動再接続では他参加者への通知を
// 一切行わない現行の設計は維持しつつ、ユーザーが明示的に再入室した場合だけ
// participant_joined を再送し、チャットのアクティビティログに「参加しました」
// を残せるようにする。
func (m *Manager) Join(ctx context.Context, sessionID, token, participantID, displayName, avatarIcon string, announceRejoin bool, conn Conn) (rec *session.Record, self *session.Participant, all []*session.Participant, err error) {
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
	// 画面に復帰した（再接続した）ので、保留中の復帰猶予タイマーがあれば止める
	// （ReturnGracePeriod、新設）。
	if t, ok := r.returnTimers[self.ID]; ok {
		t.Stop()
		delete(r.returnTimers, self.ID)
	}
	recCopy := *r.rec
	allSnapshot := snapshotParticipants(r)
	peers := otherConns(r, self.ID)
	r.mu.Unlock()

	// 新規ゲストの参加、または明示的な再入室(announceRejoin)の場合のみ
	// 他参加者へparticipant_joinedを通知する（通常の自動再接続では通知しない、
	// 2026-09-01改訂）。再入室の場合、既にDisconnect時点でparticipant_leftが
	// 配信されて相手側の参加者一覧から取り除かれているため、再接続時も
	// 同じイベント（＝再度リストへ追加させる形）を使うのが自然。
	announceJoin := isNewGuest || (role == session.RoleGuest && announceRejoin)
	if announceJoin {
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
//
// ホストの切断は復帰猶予を設けず即座にセッション全体を終了する（2026-09-02
// 改訂、ユーザー指示）。ホスト不在のまま位置共有を続ける意味は無いため。
// タブを閉じた場合に限らず、ネットワーク瞬断などあらゆる切断が対象になる
// （ホスト側だけ再接続で復帰させたい場合は、この早期終了より前に専用の
// 「猶予あり切断」経路を別途設ける必要がある — 現状はユーザー指示通り
// 即終了で統一している）。
//
// ゲストの切断は従来通り、参加者情報を残したまま復帰猶予タイマー
// （ReturnGracePeriod）を起動する。他の接続中参加者全員へ participant_left
// をブロードキャストし（不具合修正§0: v1では固定の1名にしか送っていなかった）、
// 猶予時間内に再接続（Join）すればタイマーはキャンセルされ、しなければ
// そのゲストのみ個別退出扱いとする（handleReturnTimeout）。
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
	var role session.Role
	if p, ok := r.participants[participantID]; ok {
		displayName = p.DisplayName
		role = p.Role
	}

	if role == session.RoleHost {
		r.mu.Unlock()
		m.teardown(context.Background(), sessionID, EventSessionEnded, "host_disconnected")
		return
	}

	peers := otherConns(r, participantID)

	if t, ok := r.returnTimers[participantID]; ok {
		t.Stop()
	}
	r.returnTimers[participantID] = time.AfterFunc(ReturnGracePeriod, func() {
		m.handleReturnTimeout(sessionID, participantID)
	})
	r.mu.Unlock()

	msg := participantLeftMsg{Type: EventParticipantLeft, ParticipantID: participantID, DisplayName: displayName}
	for _, c := range peers {
		_ = c.Send(msg)
	}
}

// handleReturnTimeout は復帰猶予タイマー（ReturnGracePeriod）が発火した際に呼ばれる。
// タイマー起動後に再接続済み、またはセッションが別経路（手動終了・TTL失効）で
// 既に片付いている場合は何もしない。ホストの切断はDisconnectで即座に処理
// されるため（2026-09-02改訂）、このタイマーはゲストの切断からしか発生しない。
func (m *Manager) handleReturnTimeout(sessionID, participantID string) {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	_, reconnected := r.conns[participantID]
	_, stillPending := r.returnTimers[participantID]
	r.mu.Unlock()
	if reconnected || !stillPending {
		return
	}

	// ゲストが10分間画面に復帰しなかった場合、そのゲストのみ個別退出させる（新設）。
	// participant_leftは既にDisconnect時点で配信済みのため、ここでは再送しない。
	m.removeParticipant(context.Background(), sessionID, participantID)
}

// removeParticipant はゲスト参加者1人を、復帰猶予切れにより恒久的に退出させる。
// メモリ・DBの両方から取り除き、以後は同じparticipantIdでJoin（再接続）しても
// 復帰できないようにする。
func (m *Manager) removeParticipant(ctx context.Context, sessionID, participantID string) {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	delete(r.participants, participantID)
	delete(r.returnTimers, participantID)
	r.mu.Unlock()

	if err := m.store.DeleteParticipant(ctx, participantID); err != nil && m.log != nil {
		m.log.Error("delete inactive participant failed", "session", sessionID, "participant", participantID, "err", err)
	}
}

// UpdateLocation は location_update メッセージ（仕様書§5.4）を反映する。
// kind="target"（目的地）はロールがホストの参加者のみ設定可能
// （なりすまし防止、仕様書§8-8を踏襲）。kind="live" は全ロール許可。
// kind="live"の場合、extraで渡された移動手段・ETA・経路情報（電車モードの
// ポリライン・乗換駅名を含む、§7, §7.1.1）も併せて反映し、目的地への到着検知
// （§12.1-①）も行う。更新内容は永続化した上で、他の接続中参加者全員へ
// ブロードキャストする。
func (m *Manager) UpdateLocation(ctx context.Context, sessionID, participantID string, kind session.Kind, loc session.LocationState, address string, extra LiveExtras) error {
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

	arrived := false
	switch kind {
	case session.KindTarget:
		r.rec.DestLat, r.rec.DestLng, r.rec.DestAddress, r.rec.DestUpdatedAt = loc.Lat, loc.Lng, address, loc.UpdatedAt
	case session.KindLive:
		locCopy := loc
		self.Live = &locCopy
		if session.ValidTransportMode(extra.TransportMode) {
			self.TransportMode = extra.TransportMode
		}
		if extra.ETASeconds != nil {
			self.ETASeconds = extra.ETASeconds
		}
		// 到着検知（仕様書§12.1-①）: 目的地から一定半径以内、かつ未到着の場合のみ。
		if self.ArrivedAt == nil && haversineMeters(loc.Lat, loc.Lng, r.rec.DestLat, r.rec.DestLng) <= arrivalRadiusMeters {
			now := time.Now().UTC()
			self.ArrivedAt = &now
			arrived = true
		}
	}
	role, displayName, avatarIcon := self.Role, self.DisplayName, self.AvatarIcon
	transportMode, etaSeconds, arrivedAt := self.TransportMode, self.ETASeconds, self.ArrivedAt
	peers := otherConns(r, participantID)
	var allConns []Conn
	if arrived {
		allConns = allConnsIncludingSelf(r)
	}
	r.mu.Unlock()

	var persistErr error
	switch kind {
	case session.KindTarget:
		persistErr = m.store.UpdateTarget(ctx, sessionID, loc.Lat, loc.Lng, address, loc.UpdatedAt)
	case session.KindLive:
		persistErr = m.store.UpdateParticipantLive(ctx, participantID, loc)
		if persistErr == nil && (session.ValidTransportMode(extra.TransportMode) || extra.ETASeconds != nil) {
			persistErr = m.store.UpdateParticipantTransport(ctx, participantID, transportMode, etaSeconds)
		}
	}
	if persistErr != nil && m.log != nil {
		// メモリ上の状態（＝ライブ配信の内容）は既に正しく、次回の更新で
		// 古い DB の行はどのみち上書きされるため、永続化の失敗だけで
		// ライブ更新自体を失敗扱いにはしない（v1からの方針を踏襲）。
		m.log.Error("persist location update failed", "session", sessionID, "participant", participantID, "err", persistErr)
	}
	if arrived {
		if err := m.store.UpdateParticipantArrival(ctx, participantID, *arrivedAt); err != nil && m.log != nil {
			m.log.Error("persist arrival failed", "session", sessionID, "participant", participantID, "err", err)
		}
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
		TransportMode: transportMode,
		ETASeconds:    etaSeconds,
		RoutePolyline: extra.RoutePolyline,
		RouteSteps:    extra.RouteSteps,
		UpdatedAt:     loc.UpdatedAt,
	}
	for _, c := range peers {
		_ = c.Send(msg)
	}

	if arrived {
		arrivedMsg := participantArrivedMsg{
			Type:          EventParticipantArrived,
			ParticipantID: participantID,
			DisplayName:   displayName,
			ArrivedAt:     *arrivedAt,
		}
		for _, c := range allConns { // 到着した本人にも通知する（サーバー判定の結果を確認できるように）
			_ = c.Send(arrivedMsg)
		}
	}
	return nil
}

// UpdateTransport は transport_update メッセージ（仕様書§7、GPS更新を伴わない
// 移動手段のみの変更）を反映する。既に送信済みのライブ位置があれば、それを
// 使って peer_location 相当のブロードキャストを再送する（位置は変えず
// transportMode/etaSecondsだけ更新した形で他参加者に伝える）。ライブ位置が
// まだ無い参加者（初回GPS取得前）の場合はブロードキャストしない（次に
// location_update が届いた時点で反映される）。
func (m *Manager) UpdateTransport(ctx context.Context, sessionID, participantID string, transportMode session.TransportMode, etaSeconds *int) error {
	if !session.ValidTransportMode(transportMode) {
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
	self.TransportMode = transportMode
	if etaSeconds != nil {
		self.ETASeconds = etaSeconds
	}
	live := self.Live
	role, displayName, avatarIcon, effectiveETA := self.Role, self.DisplayName, self.AvatarIcon, self.ETASeconds
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	if err := m.store.UpdateParticipantTransport(ctx, participantID, transportMode, etaSeconds); err != nil && m.log != nil {
		m.log.Error("persist transport update failed", "session", sessionID, "participant", participantID, "err", err)
	}

	if live == nil {
		return nil // まだライブ位置が無いので、他参加者へ知らせる地図上の対象がない
	}
	msg := peerLocationMsg{
		Type:          EventPeerLocation,
		ParticipantID: participantID,
		Role:          role,
		DisplayName:   displayName,
		AvatarIcon:    avatarIcon,
		Kind:          session.KindLive,
		Lat:           live.Lat,
		Lng:           live.Lng,
		Accuracy:      live.Accuracy,
		TransportMode: transportMode,
		ETASeconds:    effectiveETA,
		UpdatedAt:     live.UpdatedAt,
	}
	for _, c := range peers {
		_ = c.Send(msg)
	}
	return nil
}

// SendExpression は expression メッセージ（仕様書§12.1-④⑤）を処理する。
// 本人以外の接続中参加者へ peer_expression をブロードキャストするのみで、
// DBには何も保存しない。
func (m *Manager) SendExpression(sessionID, participantID, kind, text string) error {
	if kind != "stamp" && kind != "reaction" {
		return session.ErrForbidden
	}
	if kind == "reaction" {
		text = "" // リアクションはテキストを持たない（仕様書§12.1-⑤）
	}
	if utf8.RuneCountInString(text) > MaxExpressionTextLength {
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
	if last, ok := r.expressionCooldown[participantID]; ok && time.Since(last) < ExpressionCooldown {
		r.mu.Unlock()
		return session.ErrRateLimited
	}
	r.expressionCooldown[participantID] = time.Now()
	displayName, avatarIcon := self.DisplayName, self.AvatarIcon
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	msg := peerExpressionMsg{
		Type:          "peer_expression",
		ParticipantID: participantID,
		DisplayName:   displayName,
		AvatarIcon:    avatarIcon,
		Kind:          kind,
		Text:          text,
		SentAt:        time.Now().UTC(),
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
		for _, t := range r.returnTimers {
			t.Stop()
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

// allConnsIncludingSelf は接続中の全コネクション（本人含む）を返す。
// 到着通知（仕様書§12.1-①）のみ本人にも送るために使う。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func allConnsIncludingSelf(r *room) []Conn {
	out := make([]Conn, 0, len(r.conns))
	for _, c := range r.conns {
		if c != nil {
			out = append(out, c)
		}
	}
	return out
}

// haversineMeters は2点間の距離をハーバーサイン公式で概算する（メートル単位）。
// web/lib/geolocation.ts のクライアント側実装と同じ式のGo版。
func haversineMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const earthRadiusMeters = 6371000.0
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLng := toRad(lng2 - lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusMeters * math.Asin(math.Sqrt(a))
}
