// transitroute パッケージは電車モードの経路探索を扱う。NAVITIME乗換検索API
// (RapidAPI経由)を優先し、月間無料枠(500回)を使い切ったらジョルダン乗換案内
// オープンAPIへ自動的に切り替える(仕様書§7.1〜§7.1.3)。どちらのプロバイダを
// 使うかはこのパッケージ内で完結し、呼び出し元(api層)は意識しない。
//
// 2026-08-30時点、ジョルダンAPIは申請・審査中でアクセスキー未取得のため、
// 実際に有効化されているのはNAVITIMEのみ。ジョルダンのアクセスキーが発行され
// 次第、環境変数に設定するだけで自動的に有効化される(コード変更不要)。
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
// NavitimeClient・JorudanClientの両方がこれを実装する。
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
// 閾値（仕様書§7.1.2）。この値未満ならNAVITIMEを使い、到達したらジョルダンへ
// 切り替える。
const NavitimeMonthlyLimit = 480

// Router は複数プロバイダを優先順位付きで切り替える（仕様書§7.1.2）。
type Router struct {
	navitime Provider
	jorudan  Provider
	usage    UsageStore
	log      *slog.Logger
}

// NewRouter は Router を生成する。navitime/jorudanはnilでもよい
// （Provider.Configured()がfalseの場合と同様にスキップされる）。
func NewRouter(navitime, jorudan Provider, usage UsageStore, log *slog.Logger) *Router {
	return &Router{navitime: navitime, jorudan: jorudan, usage: usage, log: log}
}

// ComputeRoute はNAVITIME優先、無料枠超過またはエラー時はジョルダンへフォール
// バックする（仕様書§7.1.2）。プロバイダの切替はレスポンス形状（Route）に一切
// 影響しない — 呼び出し元には透過的。切替が起きてもユーザーへの通知は行わない
// （確定、§7.1.2）。
func (r *Router) ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error) {
	month := time.Now().UTC().Format("2006-01")

	if r.navitime != nil && r.navitime.Configured() {
		count, err := r.usage.GetUsage(ctx, r.navitime.Name(), month)
		if err != nil && r.log != nil {
			r.log.Error("get navitime usage failed", "err", err)
		}
		if err == nil && count < NavitimeMonthlyLimit {
			route, rErr := r.navitime.ComputeRoute(ctx, from, to)
			if rErr == nil {
				if _, uErr := r.usage.IncrementUsage(ctx, r.navitime.Name(), month); uErr != nil && r.log != nil {
					r.log.Error("increment navitime usage failed", "err", uErr)
				}
				return route, nil
			}
			if errors.Is(rErr, ErrNoRoute) {
				// 経路が無いのはプロバイダを変えても変わらないため、即座に返す
				// （フォールバックしても無駄なAPIコールになるだけ）。
				return nil, rErr
			}
			if r.log != nil {
				r.log.Warn("navitime request failed, falling back to jorudan", "err", rErr)
			}
		}
	}

	if r.jorudan != nil && r.jorudan.Configured() {
		route, err := r.jorudan.ComputeRoute(ctx, from, to)
		if err == nil {
			if _, uErr := r.usage.IncrementUsage(ctx, r.jorudan.Name(), month); uErr != nil && r.log != nil {
				r.log.Error("increment jorudan usage failed", "err", uErr)
			}
		}
		return route, err
	}

	return nil, ErrNoProviderAvailable
}
