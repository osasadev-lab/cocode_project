package session

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned by Store implementations when a session id does
// not exist (or has already been deleted).
var ErrNotFound = errors.New("session: not found")

// Store persists sessions to Supabase (Postgres). It is the only component
// allowed to hold database credentials (spec §8-7) — handlers and the
// in-memory hub never talk to Postgres directly.
type Store interface {
	// Insert creates a new session row with the given tokens, TTL and
	// initial meeting point, returning the fully populated record
	// (including the DB-generated id and created_at).
	Insert(ctx context.Context, tokenA, tokenB string, ttl time.Duration, target LocationState) (*Record, error)

	// Get loads a session by id. Returns ErrNotFound if it doesn't exist.
	Get(ctx context.Context, id string) (*Record, error)

	// UpdateLocation overwrites the location column matching role+kind
	// (loc_a_target, loc_a_live or loc_b_live).
	UpdateLocation(ctx context.Context, id string, role Role, kind Kind, loc LocationState) error

	// Delete removes a session row. It is idempotent: deleting an
	// already-deleted session is not an error.
	Delete(ctx context.Context, id string) error
}
