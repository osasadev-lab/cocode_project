package transitroute

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const navitimeHost = "navitime-transport.p.rapidapi.com"
const navitimeEndpoint = "https://" + navitimeHost + "/v1/route_transit"

// NavitimeClient はNAVITIME乗換検索API(RapidAPI経由)を呼び出す（仕様書§7.1.3）。
// 緯度経度をそのまま指定でき、GeoJSON形式の経路シェイプ・路線名・乗換駅名を
// 取得できるため、cocodeの電車ETAプロバイダとして優先的に使う。
//
// 注意(実装時に確認すること): ホスト名・レスポンスの正確なフィールド階層は
// 公式ドキュメントの記載に基づく設計であり、実際のレスポンスでの最終確認が
// 済んでいない(2026-08-30時点、アクセスキー未取得のため)。最初の実リクエスト
// で構造が異なることが分かった場合は、navitimeResponseのタグを実際のレスポン
// スに合わせて修正すること。
type NavitimeClient struct {
	apiKey string
	http   *http.Client
}

func NewNavitimeClient(apiKey string) *NavitimeClient {
	return &NavitimeClient{apiKey: apiKey, http: &http.Client{Timeout: 8 * time.Second}}
}

func (c *NavitimeClient) Name() string     { return "navitime" }
func (c *NavitimeClient) Configured() bool { return c.apiKey != "" }

// --- レスポンスの内部表現(NAVITIME route_transitの生JSON形状) ---

type navitimeResponse struct {
	Items []struct {
		Summary struct {
			Move struct {
				Time int `json:"time"` // 分単位
			} `json:"move"`
		} `json:"summary"`
		Sections []struct {
			Type      string `json:"type"` // "point" | "move"
			Move      string `json:"move"` // "walk" | "local_train" | "train" 等
			LineName  string `json:"line_name"`
			CallingAt []struct {
				Name string `json:"name"`
			} `json:"calling_at"`
		} `json:"sections"`
		Shape json.RawMessage `json:"shape"` // GeoJSON形式(shape=trueパラメータで取得)
	} `json:"items"`
}

// ComputeRoute は from から to への電車経路を1件取得する。
func (c *NavitimeClient) ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error) {
	q := url.Values{}
	q.Set("start", fmt.Sprintf("%f,%f", from.Lat, from.Lng))
	q.Set("goal", fmt.Sprintf("%f,%f", to.Lat, to.Lng))
	q.Set("start_time", time.Now().Format(time.RFC3339))
	q.Set("shape", "true")
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
	for _, sec := range item.Sections {
		if sec.Type != "move" {
			continue
		}
		if sec.Move == "walk" {
			steps = append(steps, Step{Kind: "walk"})
			continue
		}
		step := Step{Kind: "transit", Line: sec.LineName}
		if n := len(sec.CallingAt); n > 0 {
			step.DepartureStop = sec.CallingAt[0].Name
			step.ArrivalStop = sec.CallingAt[n-1].Name
			step.NumStops = n - 1
		}
		steps = append(steps, step)
	}

	return &Route{
		ETASeconds: item.Summary.Move.Time * 60,
		Polyline:   string(item.Shape), // GeoJSON文字列のまま保持(Google Encoded Polylineとは形式が異なる点に注意)
		Steps:      steps,
	}, nil
}
