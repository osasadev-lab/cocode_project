package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all runtime configuration loaded from environment variables.
type Config struct {
	Port          string
	DatabaseURL   string
	PublicBaseURL string // base URL the frontend uses to build share links, e.g. https://cocode.example.com
	SessionTTL    time.Duration
	RateLimitRPM  int // POST /api/sessions requests allowed per IP per minute
}

// Load reads configuration from environment variables, applying sane defaults
// for local development. DATABASE_URL is required.
func Load() (*Config, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	publicBaseURL := os.Getenv("PUBLIC_BASE_URL")
	if publicBaseURL == "" {
		publicBaseURL = "http://localhost:3000"
	}

	ttl := 30 * time.Minute
	if v := os.Getenv("SESSION_TTL_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			ttl = time.Duration(n) * time.Minute
		}
	}

	rateLimit := 5
	if v := os.Getenv("RATE_LIMIT_RPM"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rateLimit = n
		}
	}

	return &Config{
		Port:          port,
		DatabaseURL:   dbURL,
		PublicBaseURL: publicBaseURL,
		SessionTTL:    ttl,
		RateLimitRPM:  rateLimit,
	}, nil
}
