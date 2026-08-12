// Package db implements session.Store against Supabase Postgres. It is the
// only package that imports a database driver; every other package talks
// to sessions through the session.Store interface.
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

// Postgres is a session.Store backed by Supabase.
type Postgres struct {
	db *sql.DB
}

// Open connects to Postgres using a standard connection string
// (e.g. Supabase's "connection pooling" URI) and ensures the sessions
// table exists.
func Open(ctx context.Context, connString string) (*Postgres, error) {
	sqlDB, err := sql.Open("pgx", connString)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	sqlDB.SetMaxOpenConns(5) // cocode runs as a single Cloud Run instance; keep the pool small
	sqlDB.SetMaxIdleConns(5)

	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	if _, err := sqlDB.ExecContext(ctx, schemaDDL); err != nil {
		return nil, fmt.Errorf("ensure schema: %w", err)
	}
	return &Postgres{db: sqlDB}, nil
}

func (p *Postgres) Close() error {
	return p.db.Close()
}

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

func (p *Postgres) Get(ctx context.Context, id string) (*session.Record, error) {
	const q = `
		select id, token_a, token_b, created_at, expires_at, loc_a_target, loc_a_live, loc_b_live
		from sessions where id = $1
	`
	row := p.db.QueryRowContext(ctx, q, id)

	var rec session.Record
	var targetJSON []byte
	var liveAJSON, liveBJSON sql.NullString

	if err := row.Scan(&rec.ID, &rec.TokenA, &rec.TokenB, &rec.CreatedAt, &rec.ExpiresAt, &targetJSON, &liveAJSON, &liveBJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, session.ErrNotFound
		}
		return nil, fmt.Errorf("get session: %w", err)
	}

	if err := json.Unmarshal(targetJSON, &rec.LocATarget); err != nil {
		return nil, fmt.Errorf("unmarshal loc_a_target: %w", err)
	}
	if liveAJSON.Valid {
		var loc session.LocationState
		if err := json.Unmarshal([]byte(liveAJSON.String), &loc); err != nil {
			return nil, fmt.Errorf("unmarshal loc_a_live: %w", err)
		}
		rec.LocALive = &loc
	}
	if liveBJSON.Valid {
		var loc session.LocationState
		if err := json.Unmarshal([]byte(liveBJSON.String), &loc); err != nil {
			return nil, fmt.Errorf("unmarshal loc_b_live: %w", err)
		}
		rec.LocBLive = &loc
	}
	return &rec, nil
}

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

func (p *Postgres) Delete(ctx context.Context, id string) error {
	if _, err := p.db.ExecContext(ctx, `delete from sessions where id = $1`, id); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

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

var _ session.Store = (*Postgres)(nil)
