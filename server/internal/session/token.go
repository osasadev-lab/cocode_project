package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// NewToken は 128 ビット以上のエントロピーを持つ、URL セーフなランダムトークンを返す。
// セッションのトークン用途にのみ使われ、他の用途（id 採番など）とは共有しない。
func NewToken() (string, error) {
	b := make([]byte, 18) // 144ビット
	// 暗号学的に安全な乱数を生成する。
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	// URL に安全な Base64（パディング無し）へエンコードして返す。
	return base64.RawURLEncoding.EncodeToString(b), nil
}
