package session

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound は指定した id のセッションが存在しない（または既に削除済み）場合に返される。
var ErrNotFound = errors.New("session: not found")

// Store はセッションを Supabase (Postgres) へ永続化するためのインターフェース。
// データベース資格情報を持てるのはこのインターフェースの実装のみで、
// ハンドラやインメモリの hub は Postgres へ直接アクセスしない。
type Store interface {
	// Insert: トークン・TTL・初期の待ち合わせ地点から新しいセッション行を作成し、
	// DB が採番した id や created_at を含む完全なレコードを返す。
	Insert(ctx context.Context, tokenA, tokenB string, ttl time.Duration, target LocationState) (*Record, error)

	// Get: id からセッションを読み込む。存在しなければ ErrNotFound を返す。
	Get(ctx context.Context, id string) (*Record, error)

	// UpdateLocation: role と kind に対応する位置情報カラム
	// (loc_a_target / loc_a_live / loc_b_live) を上書きする。
	UpdateLocation(ctx context.Context, id string, role Role, kind Kind, loc LocationState) error

	// Delete: セッション行を削除する。冪等な操作であり、
	// 既に削除済みのセッションを削除してもエラーにはならない。
	Delete(ctx context.Context, id string) error
}
