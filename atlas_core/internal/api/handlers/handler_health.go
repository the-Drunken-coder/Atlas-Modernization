package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// LivenessCheck handles GET /health — process is up and serving (no dependency checks).
func (h *Handler) LivenessCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"status":  "healthy",
		"service": "atlas-core",
	})
}

// ReadinessCheck handles GET /readiness — dependency health gates traffic.
func (h *Handler) ReadinessCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// Check database health
	dbStatus := "healthy"
	dbMessage := ""
	if h.db == nil || h.db.Pool == nil {
		dbStatus = "unhealthy"
		h.requestLogger(r).Warn().Msg("health check: database not configured")
		dbMessage = "database not configured"
	} else if err := h.db.Ping(ctx); err != nil {
		dbStatus = "unhealthy"
		h.requestLogger(r).Warn().Err(err).Msg("health check: database ping failed")
		dbMessage = "database error"
	}

	// Check storage health
	storageStatus := "healthy"
	storageBucket := ""
	storageMessage := ""
	if h.storage != nil {
		storageBucket = h.storage.Bucket()
		exists, err := h.storage.BucketExists(ctx)
		if err != nil {
			storageStatus = "unhealthy"
			h.requestLogger(r).Warn().Err(err).Msg("health check: storage bucket check failed")
			storageMessage = "storage error"
		} else if !exists {
			storageStatus = "unhealthy"
			h.requestLogger(r).Warn().Str("bucket", storageBucket).Msg("health check: configured bucket missing")
			storageMessage = "storage error: bucket missing"
		}
	} else if h.config != nil && strings.TrimSpace(h.config.MinIOSecretKey) != "" {
		storageStatus = "unhealthy"
		storageMessage = "storage client unavailable"
		h.requestLogger(r).Warn().Msg("health check: configured storage client unavailable")
	} else {
		storageStatus = "unconfigured"
		storageMessage = "Storage client not configured"
	}

	overallStatus, httpStatus := readinessOutcome(dbStatus, storageStatus)

	response := map[string]interface{}{
		"status":  overallStatus,
		"service": "atlas-core",
		"checks": map[string]interface{}{
			"database": map[string]interface{}{
				"status":  dbStatus,
				"message": dbMessage,
			},
			"storage": map[string]interface{}{
				"status":  storageStatus,
				"bucket":  storageBucket,
				"message": storageMessage,
			},
		},
	}

	writeJSON(w, r, httpStatus, response)
}

func readinessOutcome(databaseStatus, storageStatus string) (string, int) {
	if databaseStatus == "unhealthy" || storageStatus == "unhealthy" {
		return "unhealthy", http.StatusServiceUnavailable
	}
	if storageStatus == "unconfigured" {
		return "degraded", http.StatusOK
	}
	return "healthy", http.StatusOK
}

// Root handles GET /.
func (h *Handler) Root(w http.ResponseWriter, r *http.Request) {
	response := map[string]interface{}{
		"name":        "ATLAS Core API",
		"version":     "1.0.0",
		"description": "Core backend service for ATLAS",
		"endpoints": map[string]string{
			"health":          "/health",
			"readiness":       "/readiness",
			"resources":       "/resources",
			"command_catalog": "/command-catalog",
			"entities":        "/entities",
			"tasks":           "/tasks",
			"objects":         "/objects",
			"queries":         "/queries/full",
			"changed_since":   "/queries/changed-since",
		},
	}

	writeJSON(w, r, http.StatusOK, response)
}
