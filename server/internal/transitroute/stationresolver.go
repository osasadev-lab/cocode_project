package transitroute

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// mapTilerStationResolver はMapTiler Geocoding APIの逆ジオコーディングを使って
// 最寄り駅名を解決する（仕様書§7.1.3）。既存のMapTiler依存(§10の住所検索で
// フロントエンドが使用中)を流用し、新規の外部サービス契約を増やさない。
//
// 注意: 逆ジオコーディングが確実に「駅」のPOI名を返せるかは、本書執筆時点
// (2026-08-30)では未検証。ジョルダンAPIの利用審査が完了し、実際にこの経路が
// 使われるようになった時点で確認すること。返ってくる地点が駅ではない場合、
// ジョルダンの駅名検索(sen)でうまくマッチしない可能性がある。
type mapTilerStationResolver struct {
	apiKey string
	http   *http.Client
}

// NewMapTilerStationResolver は StationResolver を生成する。apiKeyが空文字でも
// エラーにはならないが、呼び出し時に失敗する(JorudanClient.Configured()が
// falseならそもそも呼ばれない経路のため実害はない)。
func NewMapTilerStationResolver(apiKey string) StationResolver {
	return &mapTilerStationResolver{apiKey: apiKey, http: &http.Client{Timeout: 5 * time.Second}}
}

type mapTilerGeocodingResponse struct {
	Features []struct {
		Text string `json:"text"`
	} `json:"features"`
}

func (r *mapTilerStationResolver) NearestStationName(ctx context.Context, point LatLng) (string, error) {
	endpoint := fmt.Sprintf("https://api.maptiler.com/geocoding/%f,%f.json?key=%s&language=ja", point.Lng, point.Lat, r.apiKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}

	resp, err := r.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("call maptiler geocoding: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("maptiler geocoding returned status %d", resp.StatusCode)
	}

	var parsed mapTilerGeocodingResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if len(parsed.Features) == 0 {
		return "", fmt.Errorf("no nearby place found")
	}
	return parsed.Features[0].Text, nil
}
