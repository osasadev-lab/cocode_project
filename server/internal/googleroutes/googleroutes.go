// googleroutes パッケージは Google Routes API（travelMode=TRANSIT）を呼び出し、
// 電車の所要時間・経路・乗換駅名を取得する（仕様書§7.1, §7.1.1）。
// APIキーをフロントエンドへ露出させないため、常にGoバックエンド経由で呼び出す。
package googleroutes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const endpoint = "https://routes.googleapis.com/directions/v2:computeRoutes"

// フィールドマスク(仕様書§7.1.1)。durationは常にETAとして必要、polylineは地図描画用、
// legs.steps.travelMode は徒歩区間/乗車区間の判別に必須、
// legs.steps.transitDetailsは乗換駅名・路線名・停車駅数の取得に必要。
const fieldMask = "routes.duration,routes.polyline.encodedPolyline," +
	"routes.legs.steps.travelMode,routes.legs.steps.distanceMeters," +
	"routes.legs.steps.transitDetails.stopDetails.departureStop.name," +
	"routes.legs.steps.transitDetails.stopDetails.arrivalStop.name," +
	"routes.legs.steps.transitDetails.transitLine.name," +
	"routes.legs.steps.transitDetails.stopCount"

type LatLng struct {
	Lat float64
	Lng float64
}

// TransitStep は経路の1区間（徒歩または乗車、仕様書§7.1.1）。
type TransitStep struct {
	Kind           string `json:"kind"` // "walk" | "transit"
	DistanceMeters int    `json:"distanceMeters,omitempty"`
	Line           string `json:"line,omitempty"`
	DepartureStop  string `json:"departureStop,omitempty"`
	ArrivalStop    string `json:"arrivalStop,omitempty"`
	NumStops       int    `json:"numStops,omitempty"`
}

// TransitRoute は computeRoutes(travelMode=TRANSIT) の結果を、
// cocode側のレスポンス形式にマッピングしたもの。
type TransitRoute struct {
	ETASeconds int
	Polyline   string
	Steps      []TransitStep
}

// ErrNoRoute は経路が見つからなかった場合に返される（例: 深夜で運行便が無い等）。
var ErrNoRoute = fmt.Errorf("googleroutes: no route found")

type Client struct {
	apiKey string
	http   *http.Client
}

func NewClient(apiKey string) *Client {
	return &Client{apiKey: apiKey, http: &http.Client{Timeout: 8 * time.Second}}
}

// Configured はAPIキーが設定されているかどうか。
func (c *Client) Configured() bool { return c.apiKey != "" }

// --- リクエスト/レスポンスの内部表現(Googleの生JSON形状) ---

type computeRoutesReq struct {
	Origin       waypoint `json:"origin"`
	Destination  waypoint `json:"destination"`
	TravelMode   string   `json:"travelMode"`
	LanguageCode string   `json:"languageCode"`
	Units        string   `json:"units"`
}

type waypoint struct {
	Location location `json:"location"`
}

type location struct {
	LatLng latLngJSON `json:"latLng"`
}

type latLngJSON struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type computeRoutesResp struct {
	Routes []struct {
		Duration string `json:"duration"` // 例: "1234s"（google.protobuf.Durationの文字列表現）
		Polyline struct {
			EncodedPolyline string `json:"encodedPolyline"`
		} `json:"polyline"`
		Legs []struct {
			Steps []struct {
				TravelMode     string `json:"travelMode"` // "WALK" | "TRANSIT"
				DistanceMeters int    `json:"distanceMeters"`
				TransitDetails *struct {
					StopDetails struct {
						DepartureStop struct {
							Name string `json:"name"`
						} `json:"departureStop"`
						ArrivalStop struct {
							Name string `json:"name"`
						} `json:"arrivalStop"`
					} `json:"stopDetails"`
					TransitLine struct {
						Name string `json:"name"`
					} `json:"transitLine"`
					StopCount int `json:"stopCount"`
				} `json:"transitDetails"`
			} `json:"steps"`
		} `json:"legs"`
	} `json:"routes"`
}

// ComputeTransitRoute は from から to への電車経路を1件取得する。
//
// 注意(実装時に確認すること): routes.legs.steps.distanceMeters の正確な
// フィールドパスは、本パッケージ作成時に公式ドキュメントの網羅的な記載を
// 確認できなかった(travelModeでの徒歩/乗車判定・transitDetails配下の
// フィールドパスは公式リファレンスで確認済み)。実際のレスポンス例で
// 最終確認し、異なる場合はcomputeRoutesRespのタグとfieldMaskを合わせて
// 修正すること。
func (c *Client) ComputeTransitRoute(ctx context.Context, from, to LatLng) (*TransitRoute, error) {
	reqBody := computeRoutesReq{
		Origin:       waypoint{Location: location{LatLng: latLngJSON{Latitude: from.Lat, Longitude: from.Lng}}},
		Destination:  waypoint{Location: location{LatLng: latLngJSON{Latitude: to.Lat, Longitude: to.Lng}}},
		TravelMode:   "TRANSIT",
		LanguageCode: "ja", // 駅名・路線名を日本語で取得する（仕様書§7.1.1）
		Units:        "METRIC",
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", c.apiKey)
	req.Header.Set("X-Goog-FieldMask", fieldMask)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call routes api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("routes api returned status %d", resp.StatusCode)
	}

	var parsed computeRoutesResp
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if len(parsed.Routes) == 0 {
		return nil, ErrNoRoute
	}
	route := parsed.Routes[0]

	etaSeconds, err := parseDurationSeconds(route.Duration)
	if err != nil {
		return nil, fmt.Errorf("parse duration %q: %w", route.Duration, err)
	}

	var steps []TransitStep
	for _, leg := range route.Legs {
		for _, step := range leg.Steps {
			switch step.TravelMode {
			case "TRANSIT":
				if step.TransitDetails == nil {
					continue
				}
				steps = append(steps, TransitStep{
					Kind:          "transit",
					Line:          step.TransitDetails.TransitLine.Name,
					DepartureStop: step.TransitDetails.StopDetails.DepartureStop.Name,
					ArrivalStop:   step.TransitDetails.StopDetails.ArrivalStop.Name,
					NumStops:      step.TransitDetails.StopCount,
				})
			default: // "WALK" 等
				steps = append(steps, TransitStep{Kind: "walk", DistanceMeters: step.DistanceMeters})
			}
		}
	}

	return &TransitRoute{ETASeconds: etaSeconds, Polyline: route.Polyline.EncodedPolyline, Steps: steps}, nil
}

// parseDurationSeconds は "1234s" / "1234.5s" 形式の文字列を秒数(整数、切り捨て)に変換する。
func parseDurationSeconds(s string) (int, error) {
	s = strings.TrimSuffix(s, "s")
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return int(f), nil
}
