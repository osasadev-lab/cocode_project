// db パッケージは session.Store を Supabase Postgres 上に実装する。
// データベースドライバに依存するのはこのパッケージのみで、
// 他のパッケージは session.Store インターフェース越しにしかセッションへアクセスしない。
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

// sessions/participants テーブルの定義（仕様書§5.3）。存在しなければ Open() 時に
// 自動で作成される。
//
// 注意(v1→v2移行、2026-08-30): v1のsessionsテーブル(token_a/token_b/loc_a_*/loc_b_*
// カラム)とは非互換のスキーマである。CREATE TABLE IF NOT EXISTSは同名テーブルが
// 既に存在する場合は何もしないため、v1スキーマのsessionsテーブルが残ったままだと
// 起動はできてもこのパッケージのクエリは全て失敗する。v1→v2移行時は、
// このコードをデプロイする前に一度だけ
//
//	drop table if exists sessions cascade;
//
// をローカルDB・本番Supabase双方に対して手動実行しておくこと。
//
// この DROP をここ（Open時に毎回実行されるスキーマ確認処理）に含めていない
// のは意図的な設計判断: cocodeはCloud Runをmin-instances=0でデプロイしており
// （デプロイ手順書参照）、アクセスが無い時間が続くとインスタンスが停止し、
// 次のリクエストでコールドスタートしてOpen()が再実行される。もしDROP TABLEを
// 自動マイグレーションに含めてしまうと、本番運用開始後はコールドスタートの
// たびに稼働中の全セッションを含むテーブルが失われることになる。そのため、
// 自動実行されるDDLはIF NOT EXISTSのみにとどめ、破壊的な移行は一度きりの
// 手動操作として分離している。
const schemaDDL = `
create table if not exists sessions (
  id              uuid primary key default gen_random_uuid(),
  token_host      text not null unique,
  token_guest     text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  dest_lat        double precision not null,
  dest_lng        double precision not null,
  dest_address    text,
  dest_updated_at timestamptz not null
);

create table if not exists participants (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
  role            text not null check (role in ('host', 'guest')),
  display_name    text not null,
  avatar_icon     text not null,
  transport_mode  text not null default 'walk' check (transport_mode in ('walk', 'car', 'train')),
  live_lat        double precision,
  live_lng        double precision,
  live_accuracy   double precision,
  live_updated_at timestamptz,
  eta_seconds     integer,
  arrived_at      timestamptz,
  joined_at       timestamptz not null default now()
);

create table if not exists feedbacks (
  id         uuid primary key default gen_random_uuid(),
  message    text not null,
  reply_to   text,
  context    text,
  created_at timestamptz not null default now()
);

create table if not exists transit_api_usage (
  provider   text not null,
  year_month text not null,
  count      integer not null default 0,
  primary key (provider, year_month)
);
`

// Postgres は Supabase 上の Postgres を実体とする session.Store の実装。
type Postgres struct {
	db *sql.DB
}

// Open は接続文字列（Supabase のコネクションプーリング用 URI など）を使って
// Postgres へ接続し、sessions/participants テーブルが存在することを保証する。
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

// InsertWithHost はセッションとホスト参加者を1トランザクションで作成する。
func (p *Postgres) InsertWithHost(ctx context.Context, tokenHost, tokenGuest string, ttl time.Duration, destLat, destLng float64, destAddress, hostDisplayName, hostAvatarIcon string) (*session.Record, *session.Participant, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // コミット成功後のRollbackはno-op

	rec := &session.Record{
		TokenHost:   tokenHost,
		TokenGuest:  tokenGuest,
		DestLat:     destLat,
		DestLng:     destLng,
		DestAddress: destAddress,
	}

	// expires_at は DB 側で now() + TTL として計算させ、時刻のズレを防ぐ。
	const insertSession = `
		insert into sessions (token_host, token_guest, expires_at, dest_lat, dest_lng, dest_address, dest_updated_at)
		values ($1, $2, now() + $3::interval, $4, $5, nullif($6, ''), now())
		returning id, created_at, expires_at, dest_updated_at
	`
	row := tx.QueryRowContext(ctx, insertSession, tokenHost, tokenGuest, fmt.Sprintf("%d seconds", int(ttl.Seconds())), destLat, destLng, destAddress)
	if err := row.Scan(&rec.ID, &rec.CreatedAt, &rec.ExpiresAt, &rec.DestUpdatedAt); err != nil {
		return nil, nil, fmt.Errorf("insert session: %w", err)
	}

	host := &session.Participant{
		SessionID:   rec.ID,
		Role:        session.RoleHost,
		DisplayName: hostDisplayName,
		AvatarIcon:  hostAvatarIcon,
	}
	const insertHost = `
		insert into participants (session_id, role, display_name, avatar_icon)
		values ($1, 'host', $2, $3)
		returning id, transport_mode, joined_at
	`
	row = tx.QueryRowContext(ctx, insertHost, rec.ID, hostDisplayName, hostAvatarIcon)
	if err := row.Scan(&host.ID, &host.TransportMode, &host.JoinedAt); err != nil {
		return nil, nil, fmt.Errorf("insert host participant: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, nil, fmt.Errorf("commit tx: %w", err)
	}
	return rec, host, nil
}

// Get は id からセッション本体を取得する。存在しなければ session.ErrNotFound を返す。
func (p *Postgres) Get(ctx context.Context, id string) (*session.Record, error) {
	const q = `
		select id, token_host, token_guest, created_at, expires_at, dest_lat, dest_lng, coalesce(dest_address, ''), dest_updated_at
		from sessions where id = $1
	`
	row := p.db.QueryRowContext(ctx, q, id)

	var rec session.Record
	if err := row.Scan(&rec.ID, &rec.TokenHost, &rec.TokenGuest, &rec.CreatedAt, &rec.ExpiresAt, &rec.DestLat, &rec.DestLng, &rec.DestAddress, &rec.DestUpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, session.ErrNotFound
		}
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &rec, nil
}

// ListParticipants はセッションに紐づく全参加者を参加順(joined_at)で取得する。
func (p *Postgres) ListParticipants(ctx context.Context, sessionID string) ([]*session.Participant, error) {
	const q = `
		select id, session_id, role, display_name, avatar_icon, transport_mode,
		       live_lat, live_lng, live_accuracy, live_updated_at, eta_seconds, arrived_at, joined_at
		from participants where session_id = $1 order by joined_at
	`
	rows, err := p.db.QueryContext(ctx, q, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	defer rows.Close()

	var out []*session.Participant
	for rows.Next() {
		part, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, part)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	return out, nil
}

// InsertParticipant は新規ゲスト参加者を作成する。
// 上限（session.MaxParticipants）到達時は session.ErrParticipantLimit を返し、INSERTは行わない。
func (p *Postgres) InsertParticipant(ctx context.Context, sessionID, displayName, avatarIcon string) (*session.Participant, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // コミット成功後のRollbackはno-op

	var count int
	if err := tx.QueryRowContext(ctx, `select count(*) from participants where session_id = $1`, sessionID).Scan(&count); err != nil {
		return nil, fmt.Errorf("count participants: %w", err)
	}
	if count >= session.MaxParticipants {
		return nil, session.ErrParticipantLimit
	}

	part := &session.Participant{
		SessionID:   sessionID,
		Role:        session.RoleGuest,
		DisplayName: displayName,
		AvatarIcon:  avatarIcon,
	}
	const q = `
		insert into participants (session_id, role, display_name, avatar_icon)
		values ($1, 'guest', $2, $3)
		returning id, transport_mode, joined_at
	`
	row := tx.QueryRowContext(ctx, q, sessionID, displayName, avatarIcon)
	if err := row.Scan(&part.ID, &part.TransportMode, &part.JoinedAt); err != nil {
		return nil, fmt.Errorf("insert guest participant: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return part, nil
}

// GetParticipant は participantId から参加者を取得する（再接続時の検証用）。
// 存在しなければ session.ErrNotFound を返す。
func (p *Postgres) GetParticipant(ctx context.Context, sessionID, participantID string) (*session.Participant, error) {
	const q = `
		select id, session_id, role, display_name, avatar_icon, transport_mode,
		       live_lat, live_lng, live_accuracy, live_updated_at, eta_seconds, arrived_at, joined_at
		from participants where session_id = $1 and id = $2
	`
	row := p.db.QueryRowContext(ctx, q, sessionID, participantID)
	part, err := scanParticipant(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, session.ErrNotFound
		}
		return nil, err
	}
	return part, nil
}

// UpdateTarget はセッションの目的地を更新する。
func (p *Postgres) UpdateTarget(ctx context.Context, sessionID string, lat, lng float64, address string, updatedAt time.Time) error {
	const q = `update sessions set dest_lat = $1, dest_lng = $2, dest_address = nullif($3, ''), dest_updated_at = $4 where id = $5`
	if _, err := p.db.ExecContext(ctx, q, lat, lng, address, updatedAt, sessionID); err != nil {
		return fmt.Errorf("update target: %w", err)
	}
	return nil
}

// UpdateParticipantLive は参加者のライブ位置を更新する。
func (p *Postgres) UpdateParticipantLive(ctx context.Context, participantID string, loc session.LocationState) error {
	const q = `update participants set live_lat = $1, live_lng = $2, live_accuracy = $3, live_updated_at = $4 where id = $5`
	if _, err := p.db.ExecContext(ctx, q, loc.Lat, loc.Lng, loc.Accuracy, loc.UpdatedAt, participantID); err != nil {
		return fmt.Errorf("update participant live: %w", err)
	}
	return nil
}

// UpdateParticipantProfile は参加者の表示名・アイコンを更新する（仕様書§14.5）。
func (p *Postgres) UpdateParticipantProfile(ctx context.Context, participantID, displayName, avatarIcon string) error {
	const q = `update participants set display_name = $1, avatar_icon = $2 where id = $3`
	if _, err := p.db.ExecContext(ctx, q, displayName, avatarIcon, participantID); err != nil {
		return fmt.Errorf("update participant profile: %w", err)
	}
	return nil
}

// UpdateParticipantTransport は参加者の移動手段・ETAを更新する（仕様書§7, §9）。
func (p *Postgres) UpdateParticipantTransport(ctx context.Context, participantID string, transportMode session.TransportMode, etaSeconds *int) error {
	const q = `update participants set transport_mode = $1, eta_seconds = $2 where id = $3`
	if _, err := p.db.ExecContext(ctx, q, transportMode, etaSeconds, participantID); err != nil {
		return fmt.Errorf("update participant transport: %w", err)
	}
	return nil
}

// UpdateParticipantArrival は参加者の到着時刻を記録する（仕様書§12.1-①）。
func (p *Postgres) UpdateParticipantArrival(ctx context.Context, participantID string, arrivedAt time.Time) error {
	const q = `update participants set arrived_at = $1 where id = $2`
	if _, err := p.db.ExecContext(ctx, q, arrivedAt, participantID); err != nil {
		return fmt.Errorf("update participant arrival: %w", err)
	}
	return nil
}

// InsertFeedback はfeedbacksテーブルへ1件保存する（仕様書§17.2）。
// session.Storeとは無関係の独立メソッド(api.FeedbackStoreインターフェースだけを満たす)。
func (p *Postgres) InsertFeedback(ctx context.Context, message, replyTo, context_ string) (string, time.Time, error) {
	const q = `
		insert into feedbacks (message, reply_to, context)
		values ($1, nullif($2, ''), nullif($3, ''))
		returning id, created_at
	`
	var id string
	var createdAt time.Time
	if err := p.db.QueryRowContext(ctx, q, message, replyTo, context_).Scan(&id, &createdAt); err != nil {
		return "", time.Time{}, fmt.Errorf("insert feedback: %w", err)
	}
	return id, createdAt, nil
}

// IncrementUsage は指定プロバイダ・年月の電車ETA API利用回数を1増やし、
// 増加後の値を返す（仕様書§7.1.2、transitroute.UsageStoreを満たす）。
func (p *Postgres) IncrementUsage(ctx context.Context, provider, yearMonth string) (int, error) {
	const q = `
		insert into transit_api_usage (provider, year_month, count)
		values ($1, $2, 1)
		on conflict (provider, year_month) do update set count = transit_api_usage.count + 1
		returning count
	`
	var count int
	if err := p.db.QueryRowContext(ctx, q, provider, yearMonth).Scan(&count); err != nil {
		return 0, fmt.Errorf("increment transit api usage: %w", err)
	}
	return count, nil
}

// GetUsage は指定プロバイダ・年月の電車ETA API利用回数を返す（未記録なら0）。
func (p *Postgres) GetUsage(ctx context.Context, provider, yearMonth string) (int, error) {
	const q = `select count from transit_api_usage where provider = $1 and year_month = $2`
	var count int
	err := p.db.QueryRowContext(ctx, q, provider, yearMonth).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get transit api usage: %w", err)
	}
	return count, nil
}

// Delete はセッションを削除する（既に削除済みでもエラーにはならない。冪等）。
// participants は ON DELETE CASCADE で連動削除される。
func (p *Postgres) Delete(ctx context.Context, id string) error {
	if _, err := p.db.ExecContext(ctx, `delete from sessions where id = $1`, id); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteParticipant は個別のゲスト参加者を削除する（既に削除済みでもエラーにはならない。冪等）。
func (p *Postgres) DeleteParticipant(ctx context.Context, participantID string) error {
	if _, err := p.db.ExecContext(ctx, `delete from participants where id = $1`, participantID); err != nil {
		return fmt.Errorf("delete participant: %w", err)
	}
	return nil
}

// rowScanner は *sql.Row と *sql.Rows のどちらからも participants の1行を
// 読み取れるようにするための共通インターフェース。
type rowScanner interface {
	Scan(dest ...any) error
}

// scanParticipant は participants テーブルの1行を session.Participant にデコードする。
// ライブ位置・ETA・到着時刻はいずれも NULL 許容カラムのため、一度 sql.Null* で
// 受けてから session.Participant のポインタ型フィールドへ変換する。
func scanParticipant(row rowScanner) (*session.Participant, error) {
	var part session.Participant
	var liveLat, liveLng, liveAccuracy sql.NullFloat64
	var liveUpdatedAt sql.NullTime
	var etaSeconds sql.NullInt64
	var arrivedAt sql.NullTime

	if err := row.Scan(
		&part.ID, &part.SessionID, &part.Role, &part.DisplayName, &part.AvatarIcon, &part.TransportMode,
		&liveLat, &liveLng, &liveAccuracy, &liveUpdatedAt, &etaSeconds, &arrivedAt, &part.JoinedAt,
	); err != nil {
		return nil, fmt.Errorf("scan participant: %w", err)
	}

	if liveLat.Valid && liveLng.Valid {
		part.Live = &session.LocationState{Lat: liveLat.Float64, Lng: liveLng.Float64, Accuracy: liveAccuracy.Float64}
		if liveUpdatedAt.Valid {
			part.Live.UpdatedAt = liveUpdatedAt.Time
		}
	}
	if etaSeconds.Valid {
		v := int(etaSeconds.Int64)
		part.ETASeconds = &v
	}
	if arrivedAt.Valid {
		t := arrivedAt.Time
		part.ArrivedAt = &t
	}
	return &part, nil
}

// コンパイル時に Postgres が session.Store を満たしていることを保証する。
var _ session.Store = (*Postgres)(nil)
