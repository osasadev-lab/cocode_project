// transitroute パッケージは電車モードの経路探索を扱う。NAVITIME乗換検索API
// (RapidAPI経由)単独で運用する(仕様書§7.1〜§7.1.3)。
//
// 2026-09-03: 当初はNAVITIMEの無料枠(月500回)超過時にジョルダン乗換案内
// オープンAPIへ自動フォールバックする構成を予定していたが、ジョルダン側の
// 利用審査が不承認となったため不採用が確定し、関連コード(JorudanClient等)
// は撤去した。無料枠超過時はErrNoProviderAvailableを返す(フォールバック無し)。
package transitroute

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

// LatLng は緯度経度の1点。
type LatLng struct {
	Lat float64
	Lng float64
}

// Step は経路の1区間（徒歩または乗車、仕様書§7.1.1）。
type Step struct {
	Kind           string `json:"kind"` // "walk" | "transit"
	DistanceMeters int    `json:"distanceMeters,omitempty"`
	Line           string `json:"line,omitempty"`
	DepartureStop  string `json:"departureStop,omitempty"`
	ArrivalStop    string `json:"arrivalStop,omitempty"`
	NumStops       int    `json:"numStops,omitempty"`
}

// Route は電車モードの経路探索結果（仕様書§7.1.1のPOST /api/eta/transitレス
// ポンス形状に対応）。Polylineの実際のフォーマットはプロバイダごとに異なる
// （NAVITIMEはGeoJSON文字列、ジョルダンはシェイプを提供しないため空文字）。
type Route struct {
	ETASeconds int
	Polyline   string
	Steps      []Step
}

// Provider は電車経路探索の外部API実装が満たすインターフェース。
// NavitimeClientがこれを実装する。
type Provider interface {
	Name() string
	Configured() bool
	ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error)
}

// ErrNoRoute は経路が見つからなかった場合に返される。
var ErrNoRoute = errors.New("transitroute: no route found")

// ErrNoProviderAvailable はどのプロバイダも利用できない場合に返される
// （未設定、または月間上限到達かつフォールバック先も未設定）。
var ErrNoProviderAvailable = errors.New("transitroute: no provider available")

// UsageStore は月次の呼び出し回数を永続化する（仕様書§7.1.2）。
// Cloud Runはmin-instances=0でコールドスタートのたびにメモリ状態が失われる
// ため、月次カウントはメモリではなくDBで永続化する。
type UsageStore interface {
	// IncrementUsage は指定プロバイダ・年月の利用回数を1増やし、増加後の値を返す。
	IncrementUsage(ctx context.Context, provider, yearMonth string) (int, error)
	// GetUsage は指定プロバイダ・年月の利用回数を返す（未記録なら0）。
	GetUsage(ctx context.Context, provider, yearMonth string) (int, error)
}

// NavitimeMonthlyLimit はNAVITIME無料枠（月500回）に対する安全マージン込みの
// 閾値（仕様書§7.1.2）。この値に到達したら ErrNoProviderAvailable を返す
// （フォールバック先は無い、2026-09-03改訂: ジョルダン不採用確定）。
const NavitimeMonthlyLimit = 480

// Router はNAVITIMEプロバイダの呼び出しと月次利用回数の管理を担う
// （仕様書§7.1.2）。
type Router struct {
	navitime Provider
	usage    UsageStore
	log      *slog.Logger
}

// NewRouter は Router を生成する。navitimeはnilでもよい
// （Provider.Configured()がfalseの場合と同様にスキップされる）。
func NewRouter(navitime Provider, usage UsageStore, log *slog.Logger) *Router {
	return &Router{navitime: navitime, usage: usage, log: log}
}

// ComputeRoute はNAVITIMEの無料枠内であれば経路を取得する。未設定・無料枠
// 超過の場合は ErrNoProviderAvailable を返す（フォールバック先は無い、
// 2026-09-03改訂: ジョルダン不採用確定）。
func (r *Router) ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error) {
	if r.navitime == nil || !r.navitime.Configured() {
		return nil, ErrNoProviderAvailable
	}

	month := time.Now().UTC().Format("2006-01")
	count, err := r.usage.GetUsage(ctx, r.navitime.Name(), month)
	if err != nil && r.log != nil {
		r.log.Error("get navitime usage failed", "err", err)
	}
	if err != nil || count >= NavitimeMonthlyLimit {
		return nil, ErrNoProviderAvailable
	}

	route, rErr := r.navitime.ComputeRoute(ctx, from, to)
	if rErr != nil {
		return nil, rErr
	}
	if _, uErr := r.usage.IncrementUsage(ctx, r.navitime.Name(), month); uErr != nil && r.log != nil {
		r.log.Error("increment navitime usage failed", "err", uErr)
	}
	return route, nil
}
