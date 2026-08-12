package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// rateLimiter is a simple fixed-window limiter keyed by client IP, used to
// keep POST /api/sessions from being hammered by an anonymous caller
// (spec §8-5: "簡易レート制限"). It's process-local, which is fine given
// cocode's single Cloud Run instance (max-instances=1).
type rateLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	limit    int
	visitors map[string]*visitor
}

type visitor struct {
	count     int
	windowEnd time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, visitors: make(map[string]*visitor)}
}

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

// middleware rate-limits requests by remote IP.
func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rl.allow(clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "too many requests, please try again shortly")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		// Cloud Run sits behind Google's front end, which sets this header
		// with the original client IP listed first.
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
