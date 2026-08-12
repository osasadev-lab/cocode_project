package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// NewToken returns a URL-safe random token with at least 128 bits of
// entropy (spec §8-1), suitable for both session tokens and, since
// Postgres generates the session id itself, is also reused nowhere else.
func NewToken() (string, error) {
	b := make([]byte, 18) // 144 bits
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
