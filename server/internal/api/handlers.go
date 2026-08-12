// Package api implements cocode's REST surface (spec §7): creating a
// session, reading its current state on reconnect, and ending it early.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/osasadev-lab/cocode_project/server/internal/hub"
	"github.com/osasadev-lab/cocode_project/server/internal/session"
)

type Handler struct {
	hub           *hub.Manager
	publicBaseURL string
	log           *slog.Logger
	createLimiter *rateLimiter
}

func NewHandler(h *hub.Manager, publicBaseURL string, rateLimitPerMinute int, log *slog.Logger) *Handler {
	return &Handler{
		hub:           h,
		publicBaseURL: publicBaseURL,
		log:           log,
		createLimiter: newRateLimiter(rateLimitPerMinute, time.Minute),
	}
}

// Register wires cocode's REST endpoints onto mux. Only session creation is
// rate-limited (spec §8-5) — reading state and ending a session require a
// valid token already, which is a much stronger gate than an IP count.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("POST /api/sessions", h.createLimiter.middleware(http.HandlerFunc(h.createSession)))
	mux.HandleFunc("GET /api/sessions/{id}/state", h.getState)
	mux.HandleFunc("POST /api/sessions/{id}/end", h.endSession)
}

type createSessionReq struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type createSessionResp struct {
	SessionID string    `json:"sessionId"`
	TokenA    string    `json:"tokenA"`
	ShareURL  string    `json:"shareUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// createSession implements POST /api/sessions. The meeting point is a
// required field, not an optional follow-up call: spec §5.1 says a share
// link must never exist before A has set where to meet.
func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !validLatLng(req.Lat, req.Lng) {
		writeError(w, http.StatusBadRequest, "lat and lng are required and must be valid coordinates")
		return
	}

	rec, err := h.hub.Create(r.Context(), session.LocationState{
		Lat:       req.Lat,
		Lng:       req.Lng,
		UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		h.log.Error("create session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	writeJSON(w, http.StatusCreated, createSessionResp{
		SessionID: rec.ID,
		TokenA:    rec.TokenA,
		ShareURL:  h.publicBaseURL + "/?s=" + rec.ID + "&t=" + rec.TokenB,
		ExpiresAt: rec.ExpiresAt,
	})
}

type stateResp struct {
	Role      session.Role           `json:"role"`
	ExpiresAt time.Time              `json:"expiresAt"`
	Target    session.LocationState  `json:"target"`
	LiveA     *session.LocationState `json:"liveA,omitempty"`
	LiveB     *session.LocationState `json:"liveB,omitempty"`
}

// getState implements GET /api/sessions/:id/state, used on page reload to
// re-sync before the WebSocket reconnects (spec §7).
func (h *Handler) getState(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")

	rec, role, err := h.hub.GetState(r.Context(), id, token)
	if err != nil {
		respondSessionErr(w, err)
		return
	}

	writeJSON(w, http.StatusOK, stateResp{
		Role:      role,
		ExpiresAt: rec.ExpiresAt,
		Target:    rec.LocATarget,
		LiveA:     rec.LocALive,
		LiveB:     rec.LocBLive,
	})
}

// endSession implements POST /api/sessions/:id/end: either participant can
// terminate the session immediately (spec §5.5).
func (h *Handler) endSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")

	if err := h.hub.End(r.Context(), id, token); err != nil {
		respondSessionErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func respondSessionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, session.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session not found or expired")
		return
	}
	writeError(w, http.StatusInternalServerError, "internal error")
}

// validLatLng rejects the zero value (an omitted field decodes to 0,0,
// which is a real but vanishingly unlikely coordinate for this app) as
// well as anything outside the valid coordinate range.
func validLatLng(lat, lng float64) bool {
	if lat == 0 && lng == 0 {
		return false
	}
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
