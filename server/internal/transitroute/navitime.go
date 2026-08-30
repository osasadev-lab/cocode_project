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
// 注意: このAPIのroute_transitエンドポイントはルート形状(polyline)を
// 返さない。形状は別エンドポイント/shape_transitで取得する必要があるが、
// 無料枠の呼び出し回数を消費するため、現時点では呼び出していない
// (ジョルダン同様、Polylineは空文字のまま)。
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
		Polyline:   "", // /shape_transitは無料枠を消費するため現時点では呼び出さない
		Steps:      steps,
	}, nil
}
