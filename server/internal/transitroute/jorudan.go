package transitroute

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const jorudanDefaultBaseURL = "https://norikae.jorudan.co.jp/bizapi"

// StationResolver は緯度経度から最寄り駅名を解決する。ジョルダンAPIの経路検索
// (sr)が座標ではなく駅名文字列を要求するため、cocode側で別途用意する必要が
// ある（仕様書§7.1.3）。
type StationResolver interface {
	NearestStationName(ctx context.Context, point LatLng) (string, error)
}

// JorudanClient はジョルダン乗換案内オープンAPI(経路検索 /sr)を呼び出す。
// NAVITIMEの無料枠(月500回)を使い切った場合の自動フォールバック用途
// （仕様書§7.1.2）。
//
// 注意(実装時に確認すること、2026-08-30時点でアクセス申請の審査待ちのため
// 未検証):
//   - アクセスキー発行時に案内される正式なエンドポイントURLに置き換えること
//     (jorudanDefaultBaseURLは公開仕様書に記載のプレースホルダー形式 example.co.jp
//     を実際のドメインに差し替えたものであり、審査完了時の案内で最終確認する)
//   - StationResolverによる座標→駅名解決の精度は未検証。解決した駅名が
//     eki1/eki2としてそのまま使えることを実際のレスポンスで確認すること
type JorudanClient struct {
	accessKey string
	baseURL   string
	resolver  StationResolver
	http      *http.Client
}

// NewJorudanClient は JorudanClient を生成する。baseURLが空文字なら
// jorudanDefaultBaseURLを使う。accessKeyが空文字ならConfigured()がfalseを
// 返し、Router側で自動的にスキップされる。
func NewJorudanClient(accessKey, baseURL string, resolver StationResolver) *JorudanClient {
	if baseURL == "" {
		baseURL = jorudanDefaultBaseURL
	}
	return &JorudanClient{accessKey: accessKey, baseURL: baseURL, resolver: resolver, http: &http.Client{Timeout: 8 * time.Second}}
}

func (c *JorudanClient) Name() string     { return "jorudan" }
func (c *JorudanClient) Configured() bool { return c.accessKey != "" }

// --- レスポンスの内部表現(ジョルダン /sr の生JSON形状。仕様書PDF準拠) ---

type jorudanSRResponse struct {
	NorikaeBizApiResult struct {
		Head struct {
			ErrorCode string `json:"errorCode"` // "0"が成功
		} `json:"head"`
		Body struct {
			Route []struct {
				Hyouka struct {
					Jikan string `json:"jikan"` // 分単位、文字列で返る
				} `json:"hyouka"`
				Path []struct {
					Rosen        string `json:"rosen"`
					RosenSyubetu string `json:"rosenSyubetu"` // "4"のとき徒歩
					From         string `json:"from"`
					To           string `json:"to"`
				} `json:"path"`
			} `json:"route"`
		} `json:"body"`
	} `json:"NorikaeBizApiResult"`
}

// ComputeRoute は from から to への電車経路を1件取得する。ジョルダンAPI自体は
// 経路のシェイプ(ポリライン)を返さないため、Route.Polylineは常に空文字になる
// (フロント側は駅間を直線で結ぶ簡略表示にフォールバックする、仕様書§7.1.1)。
func (c *JorudanClient) ComputeRoute(ctx context.Context, from, to LatLng) (*Route, error) {
	if c.resolver == nil {
		return nil, fmt.Errorf("transitroute: jorudan requires a StationResolver")
	}
	fromStation, err := c.resolver.NearestStationName(ctx, from)
	if err != nil {
		return nil, fmt.Errorf("resolve origin station: %w", err)
	}
	toStation, err := c.resolver.NearestStationName(ctx, to)
	if err != nil {
		return nil, fmt.Errorf("resolve destination station: %w", err)
	}

	form := url.Values{}
	form.Set("ak", c.accessKey)
	form.Set("eki1", fromStation)
	form.Set("eki2", toStation)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/sr", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call jorudan api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jorudan api returned status %d", resp.StatusCode)
	}

	var parsed jorudanSRResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if parsed.NorikaeBizApiResult.Head.ErrorCode != "0" {
		return nil, ErrNoRoute
	}
	routes := parsed.NorikaeBizApiResult.Body.Route
	if len(routes) == 0 {
		return nil, ErrNoRoute
	}
	route := routes[0]

	jikanMinutes, err := strconv.Atoi(route.Hyouka.Jikan)
	if err != nil {
		return nil, fmt.Errorf("parse jikan %q: %w", route.Hyouka.Jikan, err)
	}

	var steps []Step
	for _, p := range route.Path {
		if p.RosenSyubetu == "4" {
			steps = append(steps, Step{Kind: "walk"})
			continue
		}
		steps = append(steps, Step{Kind: "transit", Line: p.Rosen, DepartureStop: p.From, ArrivalStop: p.To})
	}

	return &Route{ETASeconds: jikanMinutes * 60, Polyline: "", Steps: steps}, nil
}
