package transitroute

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const navitimeHost = "navitime-route-totalnavi.p.rapidapi.com"
const navitimeEndpoint = "https://" + navitimeHost + "/route_transit"
const navitimeShapeEndpoint = "https://" + navitimeHost + "/shape_transit"

// jst is used to format start_time in local Japan time, since NAVITIME's
// route search is timetable-relative. FixedZone avoids depending on the
// container image shipping IANA tzdata.
var jst = time.FixedZone("JST", 9*60*60)

// NavitimeClient はNAVITIME乗換検索API「NAVITIME Route(totalnavi)」
// (RapidAPI経由)を呼び出す（仕様書§7.1.3）。緯度経度をそのまま指定でき、
// 路線名・乗換駅名を取得できるため、cocodeの電車ETAプロバイダとして優先的
// に使う。2026-08-30時点でRapidAPIサブスクリプション上の実レスポンスで
// 動作確認済み(Basicプラン、500回/月)。
//
// 経路形状(Polyline)について(2026-08-31改訂): route_transitエンドポイント
// 自体はルート形状を返さないため、成功時に続けて/shape_transitエンドポイント
// を呼び出して取得する(fetchShape参照)。これによりroute_transit1回につき
// 無料枠を実質2消費するため、Router側の月間上限判定(NavitimeMonthlyLimit)
// に到達するタイミングが早まるが、地図上に実際の乗換経路線を描画できる
// 価値を優先する判断（ユーザー確認済み）。shape_transit呼び出しが失敗
// (レート制限・タイムアウト等、理由を問わず)した場合はPolylineを空文字の
// ままにし、ETA自体は成功として返す — フロントエンド側はPolyline空文字の
// 場合、現在地から目的地までの概算直線を描画するフォールバックを持つ
// (web/lib/routing.ts参照)。
//
// 既知の制約(2026-08-31、実レスポンスで確認): /shape_transitは徒歩区間
// (properties.ways="walk")の形状は返すが、このRapidAPIプランでは乗車区間
// (鉄道に沿った形状)は1件も返ってこない — 複数回の乗換を含む実際の経路で
// 検証済み。そのためfetchShapeが返すPolylineは「駅までの徒歩部分は実際の
// 道なり、乗車区間は駅間を結ぶ直線」という構成になる(鉄道路線そのものに
// 沿った線ではない)。これはNAVITIME側のデータ提供範囲による制約であり、
// cocode側のバグではない。
type NavitimeClient struct {
	apiKey string
	http   *http.Client
}

func NewNavitimeClient(apiKey string) *NavitimeClient {
	return &NavitimeClient{apiKey: apiKey, http: &http.Client{Timeout: 8 * time.Second}}
}

func (c *NavitimeClient) Name() string     { return "navitime" }
func (c *NavitimeClient) Configured() bool { return c.apiKey != "" }

// --- レスポンスの内部表現(NAVITIME Route(totalnavi) route_transitの実レスポンス形状) ---

type navitimeResponse struct {
	Items []struct {
		Summary struct {
			Move struct {
				Time int `json:"time"` // 分単位
			} `json:"move"`
		} `json:"summary"`
		Sections []navitimeSection `json:"sections"`
	} `json:"items"`
}

// navitimeSection: type="point"の要素は駅・出発地・目的地1件を表し、
// type="move"の要素はその前後2つのpointの間の移動(徒歩 or 乗車)を表す。
// calling_atはmove.transport配下(options=railway_calling_atで取得)。
type navitimeSection struct {
	Type      string `json:"type"` // "point" | "move"
	Name      string `json:"name"` // point: 駅名、または"start"/"goal"
	Move      string `json:"move"` // move: "walk" | "local_train" | "train" 等
	LineName  string `json:"line_name"`
	Distance  int    `json:"distance"` // メートル
	Transport *struct {
		CallingAt []struct {
			Name string `json:"name"`
		} `json:"calling_at"`
	} `json:"transport"`
}

// ComputeRoute は from から to への電車経路を1件取得する。
func (c *NavitimeClient) ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error) {
	q := url.Values{}
	q.Set("start", fmt.Sprintf("%f,%f", from.Lat, from.Lng))
	q.Set("goal", fmt.Sprintf("%f,%f", to.Lat, to.Lng))
	q.Set("datum", "wgs84")
	q.Set("start_time", time.Now().In(jst).Format("2006-01-02T15:04:05"))
	q.Set("limit", "1")
	q.Set("options", "railway_calling_at")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, navitimeEndpoint+"?"+q.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-RapidAPI-Key", c.apiKey)
	req.Header.Set("X-RapidAPI-Host", navitimeHost)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call navitime api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("navitime api returned status %d", resp.StatusCode)
	}

	var parsed navitimeResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if len(parsed.Items) == 0 {
		return nil, ErrNoRoute
	}
	item := parsed.Items[0]

	var steps []Step
	for i, sec := range item.Sections {
		if sec.Type != "move" {
			continue
		}
		if sec.Move == "walk" {
			steps = append(steps, Step{Kind: "walk", DistanceMeters: sec.Distance})
			continue
		}
		step := Step{Kind: "transit", Line: sec.LineName, DistanceMeters: sec.Distance}
		// 前後の"point"要素が乗車駅・降車駅にあたる(実レスポンスでは
		// calling_atに降車駅自体は含まれず、途中停車駅のみが並ぶため)。
		if i > 0 && item.Sections[i-1].Type == "point" {
			step.DepartureStop = item.Sections[i-1].Name
		}
		if i+1 < len(item.Sections) && item.Sections[i+1].Type == "point" {
			step.ArrivalStop = item.Sections[i+1].Name
		}
		if sec.Transport != nil {
			step.NumStops = len(sec.Transport.CallingAt) + 1
		}
		steps = append(steps, step)
	}

	return &Route{
		ETASeconds: item.Summary.Move.Time * 60,
		Polyline:   c.fetchShape(ctx, from, to),
		Steps:      steps,
	}, nil
}

// --- /shape_transit（経路形状、地図描画用） ---

// shapeGeoJSON は/shape_transit?format=geojsonのレスポンス形状。徒歩区間・
// 乗車区間ごとに別々のFeature(LineString)として分かれて返ってくるため、
// fetchShapeで全区間ぶんの座標を出発→到着の順に連結して1本の線にする。
type shapeGeoJSON struct {
	Features []struct {
		Geometry struct {
			Type        string      `json:"type"`
			Coordinates [][]float64 `json:"coordinates"` // [lng, lat] のペアの配列(GeoJSON標準の順序)
		} `json:"geometry"`
	} `json:"features"`
}

// fetchShape はroute_transitと同じ条件(start/goal/start_time)で/shape_transit
// を呼び出し、経路全体の座標列(出発→到着の順、[lng,lat]のペア)をJSON文字列に
// エンコードして返す。失敗時(HTTPエラー・レート制限・パース失敗等、理由を
// 問わず)は空文字を返す — 呼び出し元(ComputeRoute)はこれをそのままPolylineに
// 使い、ETA自体は経路形状の有無にかかわらず正常に返す。
func (c *NavitimeClient) fetchShape(ctx context.Context, from, to LatLng) string {
	q := url.Values{}
	q.Set("start", fmt.Sprintf("%f,%f", from.Lat, from.Lng))
	q.Set("goal", fmt.Sprintf("%f,%f", to.Lat, to.Lng))
	q.Set("datum", "wgs84")
	q.Set("start_time", time.Now().In(jst).Format("2006-01-02T15:04:05"))
	q.Set("format", "geojson")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, navitimeShapeEndpoint+"?"+q.Encode(), nil)
	if err != nil {
		return ""
	}
	req.Header.Set("X-RapidAPI-Key", c.apiKey)
	req.Header.Set("X-RapidAPI-Host", navitimeHost)

	resp, err := c.http.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// レート制限(429)・無料枠超過等を含め、理由を問わず形状なしにフォール
		// バックする。ETA自体は既に取得済みのため、ここで呼び出し元へエラーを
		// 伝播させない。
		return ""
	}

	var parsed shapeGeoJSON
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return ""
	}

	var coords [][]float64
	for _, f := range parsed.Features {
		if f.Geometry.Type != "LineString" {
			continue
		}
		coords = append(coords, f.Geometry.Coordinates...)
	}
	if len(coords) == 0 {
		return ""
	}

	encoded, err := json.Marshal(coords)
	if err != nil {
		return ""
	}
	return string(encoded)
}
