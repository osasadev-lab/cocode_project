package session

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrNotFound は指定した id のセッション、または participantId の参加者が
	// 存在しない（既に削除済み含む）場合に返される。
	ErrNotFound = errors.New("session: not found")
	// ErrParticipantLimit は参加人数上限（MaxParticipants）到達時に返される。
	ErrParticipantLimit = errors.New("session: participant limit reached")
	// ErrForbidden はロール上許可されない操作が要求された場合に返される
	// （例: ゲストトークンでの終了操作、表示名/アイコン未指定での新規ゲスト参加）。
	ErrForbidden = errors.New("session: operation not allowed for this role")
	// ErrRateLimited は短時間に同じ操作を繰り返した場合に返される
	// （§12.1のexpressionクールダウンと同様のパターン、§14.5のprofile_updateで使用）。
	ErrRateLimited = errors.New("session: rate limited")
)

// MaxParticipants はセッションあたりの参加者数上限（ホスト含む、仕様書§5.2）。
const MaxParticipants = 20

// Store はセッション・参加者を Supabase (Postgres) へ永続化するためのインターフェース。
// データベース資格情報を持てるのはこのインターフェースの実装のみで、
// ハンドラやインメモリの hub は Postgres へ直接アクセスしない。
type Store interface {
	// InsertWithHost はセッションとホスト参加者を1トランザクションで作成する。
	InsertWithHost(ctx context.Context, tokenHost, tokenGuest string, ttl time.Duration, destLat, destLng float64, destAddress, hostDisplayName, hostAvatarIcon string) (*Record, *Participant, error)

	// Get はセッション本体を取得する。存在しなければ ErrNotFound。
	Get(ctx context.Context, id string) (*Record, error)

	// ListParticipants はセッションに紐づく全参加者を、参加順(joined_at)で取得する。
	ListParticipants(ctx context.Context, sessionID string) ([]*Participant, error)

	// InsertParticipant は新規ゲスト参加者を作成する。
	// 上限（MaxParticipants）到達時は ErrParticipantLimit を返す。
	InsertParticipant(ctx context.Context, sessionID, displayName, avatarIcon string) (*Participant, error)

	// GetParticipant は participantId から参加者を取得する（再接続時の検証用）。
	// 存在しなければ ErrNotFound。
	GetParticipant(ctx context.Context, sessionID, participantID string) (*Participant, error)

	// UpdateTarget はセッションの目的地を更新する。
	UpdateTarget(ctx context.Context, sessionID string, lat, lng float64, address string, updatedAt time.Time) error

	// UpdateParticipantLive は参加者のライブ位置を更新する。
	UpdateParticipantLive(ctx context.Context, participantID string, loc LocationState) error

	// UpdateParticipantProfile は参加者の表示名・アイコンを更新する
	// （共有中の変更、仕様書§14.5）。
	UpdateParticipantProfile(ctx context.Context, participantID, displayName, avatarIcon string) error

	// Delete はセッションを削除する（participants は ON DELETE CASCADE で連動削除）。
	Delete(ctx context.Context, id string) error
}
