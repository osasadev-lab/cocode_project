// Package session defines the domain model shared by the REST API,
// WebSocket hub and persistence layer: a cocode session pairs a user A
// (who sets a meeting point) with a user B (who joins via a share link),
// and both continuously share their live location while the session lives.
// session パッケージは REST API・WebSocket hub・永続化層で共有されるドメインモデルを定義する。
// cocode の「セッション」は、待ち合わせ地点を設定するユーザーA と
// 共有リンクから参加するユーザーB のペアであり、セッションが有効な間は
// 双方が継続的にライブ位置情報を共有し合う。
package session

import "time"

// Role identifies which side of a session a token/connection belongs to.
// Role はトークン/コネクションがセッションのどちら側（A or B）に属するかを表す。
type Role string

const (
	RoleA Role = "a"
	RoleB Role = "b"
)

// Kind distinguishes the meeting point A sets manually from the continuous
// live GPS location either side streams while connected.
// Kind は「A が手動で設定する待ち合わせ地点」と
// 「接続中に双方が継続的に送るライブ GPS 位置」を区別する。
type Kind string

const (
	KindTarget Kind = "target"
	KindLive   Kind = "live"
)

// LocationState is a single point in time: either A's meeting point or
// either side's live GPS fix.
// LocationState はある時点での位置情報（A の待ち合わせ地点、または片方のライブ位置）を表す。
type LocationState struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Accuracy  float64   `json:"accuracy,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Record is the full state of a session: identity, tokens, expiry and the
// three location facets shown on both users' maps.
// Record はセッションの完全な状態（識別子・トークン・有効期限、
// 両ユーザーの地図に表示される3種類の位置情報）を保持する。
type Record struct {
	ID         string
	TokenA     string
	TokenB     string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LocATarget LocationState
	LocALive   *LocationState
	LocBLive   *LocationState
}

// RoleForToken returns which role the given token belongs to, if any.
// RoleForToken は与えられたトークンがどちらの Role に属するかを判定する。
func (r *Record) RoleForToken(token string) (Role, bool) {
	switch {
	case token != "" && token == r.TokenA:
		return RoleA, true
	case token != "" && token == r.TokenB:
		return RoleB, true
	default:
		return "", false
	}
}

// Expired reports whether the session has passed its fixed TTL. This backs
// the "safety net" lazy check described in the spec: even if the in-process
// timer that should have deleted the session was lost (e.g. instance
// restart), any access re-checks expiry against the persisted timestamp.
// Expired はセッションが TTL を過ぎているかを判定する。
// これは仕様書にある「安全網」としての遅延チェックを支える仕組みで、
// インスタンス再起動などでセッション削除用のタイマーが失われた場合でも、
// アクセスの都度、永続化された有効期限と突き合わせて再チェックできる。
func (r *Record) Expired(now time.Time) bool {
	return now.After(r.ExpiresAt)
}
