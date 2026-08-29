// db パッケージは session.Store を Supabase Postgres 上に実装する。
// データベースドライバに依存するのはこのパッケージのみで、
// 他のパッケージは session.Store インターフェース越しにしかセッションへアクセスしない。
package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

// sessions テーブルの定義。存在しなければ Open() 時に自動で作成される。
const schemaDDL = `
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  token_a      text not null unique,
  token_b      text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  loc_a_target jsonb not null,
  loc_a_live   jsonb,
  loc_b_live   jsonb
);
`

// Postgres は Supabase 上の Postgres を実体とする session.Store の実装。
type Postgres struct {
	db *sql.DB
}

// Open は接続文字列（Supabase のコネクションプーリング用 URI など）を使って
// Postgres へ接続し、sessions テーブルが存在することを保証する。
func Open(ctx context.Context, connString string) (*Postgres, error) {
	// 接続をオープン（実際の TCP 接続はまだ確立しない）。
	sqlDB, err := sql.Open("pgx", connString)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	sqlDB.SetMaxOpenConns(5) // cocode は単一の Cloud Run インスタンスで動くため、プールは小さく抑える
	sqlDB.SetMaxIdleConns(5)

	// 疎通確認（Ping）と、必要ならテーブル作成（マイグレーション）を行う。
	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	if _, err := sqlDB.ExecContext(ctx, schemaDDL); err != nil {
		return nil, fmt.Errorf("ensure schema: %w", err)
	}
	return &Postgres{db: sqlDB}, nil
}

// Close はデータベース接続プールを閉じる。
func (p *Postgres) Close() error {
	return p.db.Close()
}

// Insert は新しいセッション行を作成し、DB が採番した id や created_at を
// 含む完全なレコードを返す。
func (p *Postgres) Insert(ctx context.Context, tokenA, tokenB string, ttl time.Duration, target session.LocationState) (*session.Record, error) {
	targetJSON, err := json.Marshal(target)
	if err != nil {
		return nil, fmt.Errorf("marshal target: %w", err)
	}

	rec := &session.Record{
		TokenA:     tokenA,
		TokenB:     tokenB,
		LocATarget: target,
	}

	// expires_at は DB 側で now() + TTL として計算させ、時刻のズレを防ぐ。
	const q = `
		insert into sessions (token_a, token_b, expires_at, loc_a_target)
		values ($1, $2, now() + $3::interval, $4)
		returning id, created_at, expires_at
	`
	row := p.db.QueryRowContext(ctx, q, tokenA, tokenB, fmt.Sprintf("%d seconds", int(ttl.Seconds())), targetJSON)
	if err := row.Scan(&rec.ID, &rec.CreatedAt, &rec.ExpiresAt); err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}
	return rec, nil
}

// Get は id からセッションを取得する。存在しなければ session.ErrNotFound を返す。
func (p *Postgres) Get(ctx context.Context, id string) (*session.Record, error) {
	const q = `
		select id, token_a, token_b, created_at, expires_at, loc_a_target, loc_a_live, loc_b_live
		from sessions where id = $1
	`
	row := p.db.QueryRowContext(ctx, q, id)

	var rec session.Record
	var targetJSON []byte
	var liveAJSON, liveBJSON sql.NullString

	// 行を読み取る。行が無ければ ErrNoRows を session.ErrNotFound に変換する。
	if err := row.Scan(&rec.ID, &rec.TokenA, &rec.TokenB, &rec.CreatedAt, &rec.ExpiresAt, &targetJSON, &liveAJSON, &liveBJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, session.ErrNotFound
		}
		return nil, fmt.Errorf("get session: %w", err)
	}

	// jsonb 列（目的地・A/Bのライブ位置）をそれぞれ Go の構造体へ変換する。
	if err := json.Unmarshal(targetJSON, &rec.LocATarget); err != nil {
		return nil, fmt.Errorf("unmarshal loc_a_target: %w", err)
	}
	loc, err := unmarshalNullableLocation(liveAJSON, "loc_a_live")
	if err != nil {
		return nil, err
	}
	rec.LocALive = loc

	loc, err = unmarshalNullableLocation(liveBJSON, "loc_b_live")
	if err != nil {
		return nil, err
	}
	rec.LocBLive = loc

	return &rec, nil
}

// unmarshalNullableLocation は NULL 許容の jsonb 位置情報カラムをデコードする。
// カラムが NULL の場合は nil を返す。Get 内の loc_a_live / loc_b_live で共用する。
func unmarshalNullableLocation(col sql.NullString, fieldName string) (*session.LocationState, error) {
	if !col.Valid {
		return nil, nil
	}
	var loc session.LocationState
	if err := json.Unmarshal([]byte(col.String), &loc); err != nil {
		return nil, fmt.Errorf("unmarshal %s: %w", fieldName, err)
	}
	return &loc, nil
}

// UpdateLocation は role/kind に対応する位置情報カラムを上書きする。
func (p *Postgres) UpdateLocation(ctx context.Context, id string, role session.Role, kind session.Kind, loc session.LocationState) error {
	column, err := columnFor(role, kind)
	if err != nil {
		return err
	}
	locJSON, err := json.Marshal(loc)
	if err != nil {
		return fmt.Errorf("marshal location: %w", err)
	}

	q := fmt.Sprintf(`update sessions set %s = $1 where id = $2`, column)
	if _, err := p.db.ExecContext(ctx, q, locJSON, id); err != nil {
		return fmt.Errorf("update %s: %w", column, err)
	}
	return nil
}

// Delete はセッション行を削除する。既に削除済みでもエラーにはならない（冪等）。
func (p *Postgres) Delete(ctx context.Context, id string) error {
	if _, err := p.db.ExecContext(ctx, `delete from sessions where id = $1`, id); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// columnFor は role と kind の組み合わせから対応するカラム名を決定する。
// 不正な組み合わせ（例: B の target）の場合はエラーを返す。
func columnFor(role session.Role, kind session.Kind) (string, error) {
	switch {
	case role == session.RoleA && kind == session.KindTarget:
		return "loc_a_target", nil
	case role == session.RoleA && kind == session.KindLive:
		return "loc_a_live", nil
	case role == session.RoleB && kind == session.KindLive:
		return "loc_b_live", nil
	default:
		return "", fmt.Errorf("invalid role/kind combination: role=%s kind=%s", role, kind)
	}
}

// コンパイル時に Postgres が session.Store を満たしていることを保証する。
var _ session.Store = (*Postgres)(nil)
