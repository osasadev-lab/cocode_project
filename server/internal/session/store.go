package session

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned by Store implementations when a session id does
// not exist (or has already been deleted).
// ErrNotFound は指定した id のセッションが存在しない（または既に削除済み）場合に返される。
var ErrNotFound = errors.New("session: not found")

// Store persists sessions to Supabase (Postgres). It is the only component
// allowed to hold database credentials (spec §8-7) — handlers and the
// in-memory hub never talk to Postgres directly.
// Store はセッションを Supabase (Postgres) へ永続化するためのインターフェース。
// データベース資格情報を持てるのはこのインターフェースの実装のみで、
// ハンドラやインメモリの hub は Postgres へ直接アクセスしない。
type Store interface {
	// Insert creates a new session row with the given tokens, TTL and
	// initial meeting point, returning the fully populated record
	// (including the DB-generated id and created_at).
	// Insert: トークン・TTL・初期の待ち合わせ地点から新しいセッション行を作成し、
	// DB が採番した id や created_at を含む完全なレコードを返す。
	Insert(ctx context.Context, tokenA, tokenB string, ttl time.Duration, target LocationState) (*Record, error)

	// Get loads a session by id. Returns ErrNotFound if it doesn't exist.
	// Get: id からセッションを読み込む。存在しなければ ErrNotFound を返す。
	Get(ctx context.Context, id string) (*Record, error)

	// UpdateLocation overwrites the location column matching role+kind
	// (loc_a_target, loc_a_live or loc_b_live).
	// UpdateLocation: role と kind に対応する位置情報カラム
	// (loc_a_target / loc_a_live / loc_b_live) を上書きする。
	UpdateLocation(ctx context.Context, id string, role Role, kind Kind, loc LocationState) error

	// Delete removes a session row. It is idempotent: deleting an
	// already-deleted session is not an error.
	// Delete: セッション行を削除する。冪等な操作であり、
	// 既に削除済みのセッションを削除してもエラーにはならない。
	Delete(ctx context.Context, id string) error
}
