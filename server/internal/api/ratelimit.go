package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// rateLimiter はクライアント IP ごとの単純な固定ウィンドウ方式のレート制限。
// POST /api/sessions が匿名の呼び出し元から連打されるのを防ぐ
// （仕様書§8-5「簡易レート制限」）。プロセスローカルな実装だが、
// cocode は Cloud Run の単一インスタンス（max-instances=1）で動くため問題ない。
type rateLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	limit    int
	visitors map[string]*visitor
}

// visitor は1つの IP について、現在のウィンドウ内のリクエスト回数と
// ウィンドウの終了時刻を保持する。
type visitor struct {
	count     int
	windowEnd time.Time
}

// newRateLimiter は rateLimiter を生成する。
func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, visitors: make(map[string]*visitor)}
}

// allow は key（クライアント IP）からのリクエストを許可するかどうかを判定する。
// ウィンドウが切れていればカウンタをリセットし、上限に達していれば拒否する。
func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	v, ok := rl.visitors[key]
	if !ok || now.After(v.windowEnd) {
		rl.visitors[key] = &visitor{count: 1, windowEnd: now.Add(rl.window)}
		return true
	}
	if v.count >= rl.limit {
		return false
	}
	v.count++
	return true
}

// middleware はリクエスト元 IP に基づいてレート制限を適用する Gin ミドルウェア。
func (rl *rateLimiter) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !rl.allow(clientIP(c.Request)) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many requests, please try again shortly"})
			return
		}
		c.Next()
	}
}

// clientIP はリクエストからクライアントの実 IP を取り出す。
// Cloud Run 経由の場合は X-Forwarded-For ヘッダーの先頭要素を優先し、
// 無ければ RemoteAddr から取り出す。
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		// Cloud Run は Google のフロントエンドの背後で動いており、このヘッダーの
		// 先頭要素に元のクライアント IP がセットされる。
		if i := strings.IndexByte(fwd, ','); i >= 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
