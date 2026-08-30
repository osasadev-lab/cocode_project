// session パッケージは REST API・WebSocket hub・永続化層で共有されるドメインモデルを定義する。
// cocode v2.0 の「セッション」は、目的地を設定するホスト1人と、共有リンクから
// 参加する複数のゲスト(最大20人、仕様書§5.2)からなる。参加者はホスト・ゲストの
// 区別なく Participant として扱い、Record（セッション本体）とは分離している
// （仕様書§5.3）。
package session

import "time"

// Role は参加者がセッションのどちら側（ホスト or ゲスト）に属するかを表す。
type Role string

const (
	RoleHost  Role = "host"
	RoleGuest Role = "guest"
)

// Kind は「ホストが設定する目的地」と「各参加者が継続的に送るライブ GPS 位置」を区別する。
type Kind string

const (
	KindTarget Kind = "target"
	KindLive   Kind = "live"
)

// TransportMode は参加者ごとの移動手段（仕様書§7）。
// Phase 2時点ではDBのデフォルト値（walk）を保持・配信するのみで、
// transport_update による変更処理自体はPhase 4で実装する。
type TransportMode string

const (
	TransportWalk  TransportMode = "walk"
	TransportCar   TransportMode = "car"
	TransportTrain TransportMode = "train"
)

// LocationState はある時点でのライブ位置情報（精度つき）を表す。
type LocationState struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Accuracy  float64   `json:"accuracy,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Record はセッション本体（識別子・トークン・有効期限・目的地）を保持する。
// 参加者情報は Participant に分離されている（仕様書§5.3）。
type Record struct {
	ID            string
	TokenHost     string
	TokenGuest    string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	DestLat       float64
	DestLng       float64
	DestAddress   string
	DestUpdatedAt time.Time
}

// Participant はセッションに参加する1人（ホストまたはゲスト）を表す。
type Participant struct {
	ID            string
	SessionID     string
	Role          Role
	DisplayName   string
	AvatarIcon    string
	TransportMode TransportMode
	Live          *LocationState
	ETASeconds    *int
	ArrivedAt     *time.Time
	JoinedAt      time.Time
}

// RoleForToken は与えられたトークンがホスト/ゲストどちらのものかを判定する。
func (r *Record) RoleForToken(token string) (Role, bool) {
	switch {
	case token != "" && token == r.TokenHost:
		return RoleHost, true
	case token != "" && token == r.TokenGuest:
		return RoleGuest, true
	default:
		return "", false
	}
}

// Expired はセッションが TTL を過ぎているかを判定する（安全網の遅延チェック用）。
// これは仕様書にある「安全網」としての遅延チェックを支える仕組みで、
// インスタンス再起動などでセッション削除用のタイマーが失われた場合でも、
// アクセスの都度、永続化された有効期限と突き合わせて再チェックできる。
func (r *Record) Expired(now time.Time) bool {
	return now.After(r.ExpiresAt)
}
