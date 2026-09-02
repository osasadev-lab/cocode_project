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
	"strings"
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
	EventPeerLocation        = "peer_location"
	EventParticipantJoined   = "participant_joined"
	EventParticipantLeft     = "participant_left"
	EventParticipantDeparted = "participant_departed"
	EventParticipantUpdated  = "participant_updated"
	EventParticipantArrived  = "participant_arrived"
	EventParticipantSharing  = "participant_sharing_updated"
	EventSessionEnded        = "session_ended"
	EventSessionExpired      = "session_expired"
)

// ActivityLogLimit は room が保持するチャットのアクティビティログ
// （参加/退出/到着/ひとことメッセージ）の最大保持件数（p7残課題の対応、新設）。
// 無制限に溜め続けるとメモリを圧迫するため、直近ぶんだけ保持する
// （フロントエンドのACTIVITY_LOG_LIMITと同じ値）。
const ActivityLogLimit = 30

// ActivityEntry はチャット（左サイドバー、仕様書§14.5.1）に表示される
// アクティビティログ1件ぶん。room単位でメモリ上に保持し、sync フレームに
// 含めて配信することで、参加者がページをリロードしてもチャット履歴が
// 失われないようにする（p7残課題「共有中にゲストがリロードすると、それまでの
// チャットのやり取りが消える」の対応）。DBへの永続化は行わない
// （セッションTTL=1時間の範囲内でのプロセス内メモリ保持で十分と判断）。
type ActivityEntry struct {
	Kind        string    `json:"kind"` // "joined" | "left" | "arrived" | "message"
	DisplayName string    `json:"displayName"`
	Text        string    `json:"text,omitempty"`
	At          time.Time `json:"at"`
}

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

// participantSharingMsg は位置情報オフモードの切り替え(新設)を他参加者へ
// 知らせるブロードキャスト。Sharing=falseの場合、受信側はこの参加者の
// ライブ位置表示を消す(サーバー側でも同時にParticipant.Liveをnilにしている
// ため、以後のsync/再接続でも復活しない)。
type participantSharingMsg struct {
	Type          string `json:"type"`
	ParticipantID string `json:"participantId"`
	DisplayName   string `json:"displayName"`
	Sharing       bool   `json:"sharing"`
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
	activityLog        []ActivityEntry                 // チャットのアクティビティログ（直近ActivityLogLimit件、新設）
	timer              *time.Timer
}

// appendActivity は room のアクティビティログに1件追加し、上限
// （ActivityLogLimit）を超えた古いものを切り詰める。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func appendActivity(r *room, kind, displayName, text string, at time.Time) {
	r.activityLog = append(r.activityLog, ActivityEntry{Kind: kind, DisplayName: displayName, Text: text, At: at})
	if len(r.activityLog) > ActivityLogLimit {
		r.activityLog = r.activityLog[len(r.activityLog)-ActivityLogLimit:]
	}
}

// snapshotActivity は room.activityLog のコピーを返す（sync フレーム用）。
// 呼び出し元が r.mu を保持している状態で呼ぶこと。
func snapshotActivity(r *room) []ActivityEntry {
	out := make([]ActivityEntry, len(r.activityLog))
	copy(out, r.activityLog)
	return out
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
		activityLog:        make([]ActivityEntry, 0, ActivityLogLimit),
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
// ホストトークンで、かつ participantId がホスト自身のもの(=呼び出し元が
// 既にlocalStorage等でホスト参加者の身元を知っている＝正規のホスト本人の
// ブラウザである)場合のみ、ホスト参加者自身の情報を返す。ゲストトークンで
// participantId が空の場合は self=nil を返し、参加者登録は行わない
// （初回ゲストが開くゲスト用トップページ向けのプレビュー、仕様書§5.5・§14.2。
// 呼び出し元は self==nil の場合、rec と len(all) のみを使い、all の個々の
// 要素（他参加者の表示名・位置情報）はレスポンスに含めないこと）。
//
// ホスト側でparticipantIdの一致まで要求する理由(2026-09-02新設): ホスト自身の
// ライブ画面のURLは、以前は招待リンクと全く同じ見た目で tokenHost を含んで
// いたため、誤って他人に渡ってしまうと「ゲスト用プレビュー」のつもりが
// 実際にはホスト参加者の完全な状態(他参加者全員の表示名・ライブ位置情報を
// 含むstateResp)が丸ごと返ってしまっていた。正規のホスト本人は常に
// localStorageに保存済みのparticipantIdを添えて呼び出すため、この一致
// チェックにより「tokenHostだけを知っている第三者」からの呼び出しは
// ErrNotFound(=呼び出し元は404扱い)になり、位置情報の閲覧を防げる。
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
		hp := hostParticipant(r)
		if hp == nil || participantID == "" || participantID != hp.ID {
			return nil, nil, nil, session.ErrNotFound
		}
		return &recCopy, hp, allSnapshot, nil
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
func (m *Manager) Join(ctx context.Context, sessionID, token, participantID, displayName, avatarIcon string, announceRejoin bool, conn Conn) (rec *session.Record, self *session.Participant, all []*session.Participant, activity []ActivityEntry, err error) {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return nil, nil, nil, nil, session.ErrNotFound
	}

	isNewGuest := false
	switch role {
	case session.RoleHost:
		hp := hostParticipant(r)
		// participantIdの一致を要求する(2026-09-02新設、GetStateと同じ理由)。
		// ホストの接続はparticipantId単位(=hp.IDただ1つ)で管理されており、
		// 一致チェックが無いとtokenHostだけを知っている第三者がparticipantId
		// 未指定でJoinしても「再接続」扱いになってしまい、下のr.conns[self.ID]
		// への上書きで正規ホストの接続を強制的に閉じて乗っ取れてしまっていた
		// (r.conns はparticipantId単位でただ1つの接続しか保持できないため)。
		// 正規のホスト本人は常にlocalStorage由来のparticipantIdを送るため、
		// この変更による影響はない。
		if hp == nil || participantID == "" || participantID != hp.ID {
			r.mu.Unlock()
			return nil, nil, nil, nil, session.ErrNotFound
		}
		self = hp
	case session.RoleGuest:
		if participantID != "" {
			p, ok := r.participants[participantID]
			if !ok || p.Role != session.RoleGuest {
				r.mu.Unlock()
				return nil, nil, nil, nil, session.ErrNotFound
			}
			self = p
		} else {
			if !session.ValidDisplayName(displayName) || !session.ValidAvatarIcon(avatarIcon) {
				r.mu.Unlock()
				return nil, nil, nil, nil, session.ErrForbidden
			}
			if len(r.participants) >= session.MaxParticipants {
				r.mu.Unlock()
				return nil, nil, nil, nil, session.ErrParticipantLimit
			}
			r.mu.Unlock()
			// INSERT(DB I/O)はroomのロックを持ったまま行わない。
			// 参加人数上限は store.InsertParticipant 側でも再チェックされる
			// （こちらは同時参加のごく稀な競合に対する最終防衛線）。
			newP, insErr := m.store.InsertParticipant(ctx, sessionID, displayName, avatarIcon)
			if insErr != nil {
				return nil, nil, nil, nil, insErr
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

	// 新規ゲストの参加、または明示的な再入室(announceRejoin)の場合のみ
	// 他参加者へparticipant_joinedを通知する（通常の自動再接続では通知しない、
	// 2026-09-01改訂）。再入室の場合、既にDisconnect時点でparticipant_leftが
	// 配信されて相手側の参加者一覧から取り除かれているため、再接続時も
	// 同じイベント（＝再度リストへ追加させる形）を使うのが自然。
	announceJoin := isNewGuest || (role == session.RoleGuest && announceRejoin)
	if announceJoin {
		appendActivity(r, "joined", self.DisplayName, "", time.Now().UTC())
	}

	recCopy := *r.rec
	allSnapshot := snapshotParticipants(r)
	activitySnapshotOut := snapshotActivity(r)
	peers := otherConns(r, self.ID)
	r.mu.Unlock()

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

	return &recCopy, self, allSnapshot, activitySnapshotOut, nil
}

// Disconnect はソケットが閉じた際にコネクションをセッションから切り離す。
//
// ホスト・ゲストいずれの切断も、参加者情報を残したまま復帰猶予タイマー
// （ReturnGracePeriod、10分）を起動する（2026-09-02再改訂: 以前はホストの
// 切断のみ猶予を設けず即座にteardownしていたが、ページの再読み込みも一度
// WebSocketが切れる点では他の瞬断と区別が付かず、ホストが単にリロードした
// だけでもセッションが即終了し再読み込み後に404相当のエラーになる不具合が
// あったため、ゲストと全く同じ猶予方式に統一した）。他の接続中参加者全員へ
// participant_left をブロードキャストし（不具合修正§0: v1では固定の1名に
// しか送っていなかった）、猶予時間内に再接続（Join）すればタイマーは
// キャンセルされる。猶予切れの場合の扱いはロールにより異なる
// （handleReturnTimeout参照: ゲストは個別退出、ホストはセッション終了）。
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
	p, stillPresent := r.participants[participantID]
	if !stillPresent {
		// 既に明示的な Leave()（ゲストの「退出する」）等で恒久的に退出済み
		// （参加者情報自体が消えている）。二重に通知・タイマーを起こす必要は無い。
		r.mu.Unlock()
		return
	}
	displayName := p.DisplayName

	// 画面を見ていない間、他参加者の地図に「切断直前の位置」が固まったまま
	// 残り続けないよう、位置情報共有を一時的にオフ扱いにする（p7残課題の対応、
	// 新設）。ユーザー自身が明示的にオフへ切り替えていた場合はそのまま(false)で
	// 変化なし。再接続後、次のlocation_updateが届いた時点でUpdateLocationが
	// 自動的にtrueへ戻す（本人が引き続き位置情報を共有する意思がある場合のみ、
	// ブラウザがwatchPositionを送ってくるため）。
	sharingWasOn := p.LocationSharing
	if sharingWasOn {
		p.LocationSharing = false
		p.Live = nil
	}

	peers := otherConns(r, participantID)

	if t, ok := r.returnTimers[participantID]; ok {
		t.Stop()
	}
	r.returnTimers[participantID] = time.AfterFunc(ReturnGracePeriod, func() {
		m.handleReturnTimeout(sessionID, participantID)
	})
	r.mu.Unlock()

	if sharingWasOn {
		if err := m.store.UpdateParticipantSharing(context.Background(), participantID, false); err != nil && m.log != nil {
			m.log.Error("persist location sharing update failed", "session", sessionID, "participant", participantID, "err", err)
		}
	}

	msg := participantLeftMsg{Type: EventParticipantLeft, ParticipantID: participantID, DisplayName: displayName}
	for _, c := range peers {
		_ = c.Send(msg)
	}
	if sharingWasOn {
		sharingMsg := participantSharingMsg{Type: EventParticipantSharing, ParticipantID: participantID, DisplayName: displayName, Sharing: false}
		for _, c := range peers {
			_ = c.Send(sharingMsg)
		}
	}
}

// Leave はゲストの明示的な「退出する」操作（仕様書§14.3ステップ12、および
// §5.5のREST版leaveエンドポイント）を処理する。復帰猶予（ReturnGracePeriod）
// を待たず、即座に恒久的な退出として扱う（ユーザー本人が退出の意思を明示
// しているため、10分待つ理由が無い。p7残課題「共有中にゲストがリロード
// すると、ホスト側のチャットに『退出しました』だけが残ってしまう」の対応 —
// 恒久退出の確定タイミングをremoveParticipantに一本化した上で、明示的な
// 退出だけはこの即時経路を通す）。ホストの「共有停止」はEnd()（セッション
// 全体の終了）を使うため、ここではゲストのみを対象とし、ホストトークンで
// 呼ばれた場合はErrForbiddenを返す。
//
// tokenの検証を追加（2026-09-02新設）: 元々WS経由（"leave"メッセージ）
// でしか呼ばれておらず、その時点でparticipantId（self.ID）は接続確立時の
// Join()で既にサーバー側が検証済みだった。REST版エンドポイント（共有中に
// ゲストがトップページ("/")へアクセスし、その場でWebSocket接続を持たない
// 状態のまま「退出する」を選んだ場合の安全弁、ResumeSessionChoice.tsx参照）
// を新設するにあたり、こちらはWSの事前認証を経ないため、ここで
// token_guestの検証を必須にした。ゲストは全員同じtoken_guestを共有する
// 設計（§5.1）のため、これは「他の任意のゲストの参加を第三者が終了できない」
// ことまでは保証しない（招待リンクを知っている全員が対象）— これは
// GetState等、既存の他のゲスト向けエンドポイントと同じ信頼モデルであり、
// このエンドポイント固有の弱点ではない。
func (m *Manager) Leave(ctx context.Context, sessionID, token, participantID string) error {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	if role != session.RoleGuest {
		r.mu.Unlock()
		return session.ErrForbidden
	}
	p, ok := r.participants[participantID]
	if !ok || p.Role != session.RoleGuest {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	r.mu.Unlock()

	m.removeParticipant(ctx, sessionID, participantID)
	return nil
}

// handleReturnTimeout は復帰猶予タイマー（ReturnGracePeriod）が発火した際に呼ばれる。
// タイマー起動後に再接続済み、またはセッションが別経路（手動終了・TTL失効）で
// 既に片付いている場合は何もしない。ホスト・ゲストいずれの切断からも発生する
// （2026-09-02再改訂）。
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
	var role session.Role
	if p, ok := r.participants[participantID]; ok {
		role = p.Role
	}
	r.mu.Unlock()
	if reconnected || !stillPending {
		return
	}

	if role == session.RoleHost {
		// ホストが10分間画面に復帰しなかった場合、ホスト不在のまま位置共有を
		// 続ける意味が無いため、セッション全体を終了する。
		m.teardown(context.Background(), sessionID, EventSessionEnded, "host_disconnected")
		return
	}

	// ゲストが10分間画面に復帰しなかった場合、そのゲストのみ個別退出させる（新設）。
	// participant_leftは既にDisconnect時点で配信済みのため、ここでは再送しない。
	m.removeParticipant(context.Background(), sessionID, participantID)
}

// removeParticipant はゲスト参加者1人を恒久的に退出させる（復帰猶予切れ、
// または明示的なLeave()経由）。メモリ・DBの両方から取り除き、以後は同じ
// participantIdでJoin（再接続）しても復帰できないようにする。
//
// 恒久退出が確定した時点で初めて EventParticipantDeparted をブロードキャスト
// し、チャットのアクティビティログ（仕様書§14.5.1）にも「〇〇さんが退出
// しました」を記録する（p7残課題の対応）。即時のマーカー削除・トースト通知は
// Disconnect側のEventParticipantLeftが別途担う（復帰猶予中の一時的な切断と、
// この恒久退出を混同しないための意図的な分離）。
func (m *Manager) removeParticipant(ctx context.Context, sessionID, participantID string) {
	m.mu.Lock()
	r, ok := m.rooms[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	p, ok := r.participants[participantID]
	if !ok {
		r.mu.Unlock()
		return
	}
	displayName := p.DisplayName
	delete(r.participants, participantID)
	if t, ok := r.returnTimers[participantID]; ok {
		t.Stop()
		delete(r.returnTimers, participantID)
	}
	appendActivity(r, "left", displayName, "", time.Now().UTC())
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	if err := m.store.DeleteParticipant(ctx, participantID); err != nil && m.log != nil {
		m.log.Error("delete inactive participant failed", "session", sessionID, "participant", participantID, "err", err)
	}

	msg := participantLeftMsg{Type: EventParticipantDeparted, ParticipantID: participantID, DisplayName: displayName}
	for _, c := range peers {
		_ = c.Send(msg)
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
	sharingRestored := false
	switch kind {
	case session.KindTarget:
		r.rec.DestLat, r.rec.DestLng, r.rec.DestAddress, r.rec.DestUpdatedAt = loc.Lat, loc.Lng, address, loc.UpdatedAt
	case session.KindLive:
		locCopy := loc
		self.Live = &locCopy
		// 位置情報が実際に届いた = 本人が引き続き(または再び)共有する意思がある
		// ということなので、切断中に自動でオフにされていた場合はオンへ戻す
		// （p7残課題の対応。ブラウザ側はlocationSharing=falseのときsendせず、
		// enabled=falseのままwatchPositionを送らないため、location_updateが
		// 届くこと自体が「共有オン」の信頼できるシグナルになる）。
		if !self.LocationSharing {
			self.LocationSharing = true
			sharingRestored = true
		}
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
			appendActivity(r, "arrived", self.DisplayName, "", now)
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

	if sharingRestored {
		if err := m.store.UpdateParticipantSharing(ctx, participantID, true); err != nil && m.log != nil {
			m.log.Error("persist location sharing update failed", "session", sessionID, "participant", participantID, "err", err)
		}
		sharingMsg := participantSharingMsg{Type: EventParticipantSharing, ParticipantID: participantID, DisplayName: displayName, Sharing: true}
		for _, c := range peers {
			_ = c.Send(sharingMsg)
		}
	}

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

// UpdateLocationSharing は位置情報オフモードの切り替え(新設)を反映する。
// オフにした場合は既に届いているライブ位置(Live)も破棄する — そうしないと
// 他参加者の地図上に「最後にオフにした瞬間の位置」が固まったまま残り続けて
// しまう。オンに戻した場合はLiveはnilのまま(位置はまだ届いていない状態)で、
// 次にlocation_updateが届いた時点で通常どおりマーカーが復活する。
func (m *Manager) UpdateLocationSharing(ctx context.Context, sessionID, participantID string, sharing bool) error {
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
	self.LocationSharing = sharing
	if !sharing {
		self.Live = nil
	}
	displayName := self.DisplayName
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	if err := m.store.UpdateParticipantSharing(ctx, participantID, sharing); err != nil && m.log != nil {
		m.log.Error("persist location sharing update failed", "session", sessionID, "participant", participantID, "err", err)
	}

	msg := participantSharingMsg{
		Type:          EventParticipantSharing,
		ParticipantID: participantID,
		DisplayName:   displayName,
		Sharing:       sharing,
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
	sentAt := time.Now().UTC()
	if kind == "stamp" && strings.TrimSpace(text) != "" {
		appendActivity(r, "message", displayName, text, sentAt)
	}
	peers := otherConns(r, participantID)
	r.mu.Unlock()

	msg := peerExpressionMsg{
		Type:          "peer_expression",
		ParticipantID: participantID,
		DisplayName:   displayName,
		AvatarIcon:    avatarIcon,
		Kind:          kind,
		Text:          text,
		SentAt:        sentAt,
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
//
// participantID の一致を要求する(2026-09-02新設、GetState/Joinと同じ理由・
// §5.8参照): 以前はtoken_hostだけで受理していたため、tokenHostが漏えいして
// いた場合、位置情報の閲覧やなりすましはできなくとも、第三者が他の参加者の
// セッションを勝手に終了させることができてしまっていた(可用性への影響)。
// 正規のホスト本人は常にlocalStorage由来のparticipantIdを送るため、この
// 変更による影響はない。
func (m *Manager) End(ctx context.Context, sessionID, token, participantID string) error {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	if role != session.RoleHost {
		r.mu.Unlock()
		return session.ErrForbidden
	}
	hp := hostParticipant(r)
	if hp == nil || participantID == "" || participantID != hp.ID {
		r.mu.Unlock()
		return session.ErrNotFound
	}
	r.mu.Unlock()

	m.teardown(ctx, sessionID, EventSessionEnded, "manual")
	return nil
}

// regenerateDisconnectDelay は RegenerateTokens 後、接続中の全クライアントを
// 強制切断するまでの猶予(新設)。0にせず遅延させているのは、この呼び出し元
// (ホスト自身)のブラウザがREST応答を受けてWebSocketを新トークンへ張り直す
// (page.tsxのonTokensRotated → token propの変化 → useCocodeSocketの
// 再接続エフェクト)のを、サーバー側の強制切断より確実に先行させるため。
// 猶予後に切断されるのは、ホスト自身の(既に新トークンへ張り替え済みで
// 実質無効な)古い接続と、旧トークンを持つゲスト・第三者の接続で、
// 後者は新しい招待リンクが無い限り再接続できなくなる(意図通り)。
const regenerateDisconnectDelay = 2 * time.Second

// guestConnEntry は RegenerateTokens が「再発行時点で存在した全ゲスト」を
// 即時退出させる際に使う、参加者IDとその時点の接続(未接続ならnil)の組。
type guestConnEntry struct {
	id   string
	conn Conn
}

// RegenerateTokens はホスト/ゲスト双方のトークンを新しい値へ差し替える
// (新設)。「招待リンクの代わりに誤ってブラウザのアドレスバーのURL
// (ホスト自身のトークン入り)を送ってしまった」等、トークン漏えいが疑われる
// 場合にホストが使う安全弁。ホストトークンのみ受理する。
//
// 再発行後、新トークンではRoleForTokenが一致しなくなるため、その時点で
// 存在していた全ゲストは(接続中かどうかを問わず)もう二度と再接続できない
// ことが確定する。これを「10分の復帰猶予待ちの一時切断」として扱うと、
// 実際には戻ってこないゲストが復帰猶予中ずっと参加者一覧・参加人数に
// 残り続けてしまう(ユーザー報告の不具合、2026-09-02対応)。そのため
// Disconnect()の通常経路は使わず、removeParticipant()で即座に恒久退出させる。
// 接続中のゲストには恒久退出前に session_ended を送る(2026-09-02新設) —
// フロントエンドは元々ゲストのsession_ended受信時にNotFoundScreenへ即座に
// 切り替える設計(LiveSession.tsx参照、ホストが「共有を終了する」と同じ
// 経路)のため、この1行を送るだけでゲスト側は「即終了」の見た目になる。
//
// ホスト自身の接続は個別には切断しない(役割がRoleHostの参加者は削除
// 対象から除く) — ホストはこの呼び出し元自身であり、REST応答を受けて
// 新トークンで自らWebSocketを張り直す(§5.4)。ただし念のため、
// regenerateDisconnectDelay経過時点で(ホストの新接続に置き換わっている
// はずの)古い接続を含め、その時点で残っている全接続を強制切断する。
func (m *Manager) RegenerateTokens(ctx context.Context, sessionID, token string) (*session.Record, error) {
	r, err := m.getOrLoad(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	role, ok := r.rec.RoleForToken(token)
	if !ok {
		r.mu.Unlock()
		return nil, session.ErrNotFound
	}
	if role != session.RoleHost {
		r.mu.Unlock()
		return nil, session.ErrForbidden
	}
	r.mu.Unlock()

	newTokenHost, err := session.NewToken()
	if err != nil {
		return nil, err
	}
	newTokenGuest, err := session.NewToken()
	if err != nil {
		return nil, err
	}

	if err := m.store.RegenerateTokens(ctx, sessionID, newTokenHost, newTokenGuest); err != nil {
		return nil, err
	}

	r.mu.Lock()
	r.rec.TokenHost = newTokenHost
	r.rec.TokenGuest = newTokenGuest
	recCopy := *r.rec
	guests := make([]guestConnEntry, 0, len(r.participants))
	for id, p := range r.participants {
		if p.Role == session.RoleGuest {
			guests = append(guests, guestConnEntry{id: id, conn: r.conns[id]})
		}
	}
	// staleConns は「再発行時点で接続していた全コネクション」のスナップショット
	// (2026-09-02修正)。以前はregenerateDisconnectDelay経過後にr.connsを
	// その時点で改めて読み直していたため、遅延の間に新しい招待リンクで
	// 正規に参加してきたゲスト(「再発行後のリンクをすぐに共有した」場合に
	// 発生しうる)まで巻き込んで強制切断してしまう不具合があった。ここで
	// 再発行時点のコネクションだけを確定させ、遅延後はこのスナップショットの
	// みを閉じる(ホスト自身は新トークンで別の新しいコネクションへ張り替わる
	// ため、ここに含まれる古い方だけが対象になる)。
	staleConns := make([]Conn, 0, len(r.conns))
	for _, c := range r.conns {
		staleConns = append(staleConns, c)
	}
	r.mu.Unlock()

	for _, g := range guests {
		if g.conn != nil {
			_ = g.conn.Send(reasonEventMsg{Type: EventSessionEnded, Reason: "link_regenerated"})
		}
		m.removeParticipant(ctx, sessionID, g.id)
	}

	time.AfterFunc(regenerateDisconnectDelay, func() {
		for _, c := range staleConns {
			_ = c.Close()
		}
	})

	return &recCopy, nil
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
