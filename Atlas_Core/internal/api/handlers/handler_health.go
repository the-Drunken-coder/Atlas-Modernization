package handlers

import (
	"context"
	"net/http"
	"time"
)

// LivenessCheck handles GET /health — process is up and serving (no dependency checks).
func (h *Handler) LivenessCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
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
	if err := h.db.Ping(ctx); err != nil {
		dbStatus = "unhealthy"
		h.logger.Warn().Err(err).Msg("health check: database ping failed")
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
			storageStatus = "degraded"
			h.logger.Warn().Err(err).Msg("health check: storage bucket check failed")
			storageMessage = "storage error"
		} else if !exists {
			storageStatus = "unhealthy"
			h.logger.Warn().Str("bucket", storageBucket).Msg("health check: configured bucket missing")
			storageMessage = "storage error: bucket missing"
		}
	} else {
		storageStatus = "unconfigured"
		storageMessage = "Storage client not configured"
	}

	// Determine overall status
	overallStatus := "healthy"
	httpStatus := http.StatusOK
	if dbStatus == "unhealthy" || storageStatus == "unhealthy" {
		overallStatus = "unhealthy"
		httpStatus = http.StatusServiceUnavailable
	} else if dbStatus == "degraded" || storageStatus == "degraded" || storageStatus == "unconfigured" {
		overallStatus = "degraded"
	}

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

	writeJSON(w, httpStatus, response)
}

// Root handles GET /.
func (h *Handler) Root(w http.ResponseWriter, r *http.Request) {
	response := map[string]interface{}{
		"name":        "ATLAS Core API",
		"version":     "1.0.0",
		"description": "Core backend service for ATLAS",
		"endpoints": map[string]string{
			"health":        "/health",
			"readiness":     "/readiness",
			"entities":      "/entities",
			"tasks":         "/tasks",
			"objects":       "/objects",
			"queries":       "/queries/full",
			"changed_since": "/queries/changed-since",
		},
		"links": map[string]string{
			"health":        "/health",
			"readiness":     "/readiness",
			"entities":      "/entities",
			"tasks":         "/tasks",
			"objects":       "/objects",
			"queries":       "/queries/full",
			"changed_since": "/queries/changed-since",
		},
	}

	writeJSON(w, http.StatusOK, response)
}
