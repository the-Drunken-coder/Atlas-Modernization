// Package middleware provides HTTP middleware for the Atlas Core API.
package middleware

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

// IsPublicUnauthenticatedPath returns true for routes that skip request logging and API-key auth.
func IsPublicUnauthenticatedPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	if normalized == "" {
		normalized = "/"
	}

	switch normalized {
	case "/health", "/readiness":
		return true
	default:
		return false
	}
}

// SkipsAPIKeyAuthPath returns true for routes that do not use HTTP-header API-key auth.
func SkipsAPIKeyAuthPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	if normalized == "" {
		normalized = "/"
	}
	if normalized == "/feed" {
		return true
	}
	return IsPublicUnauthenticatedPath(path)
}

// RequestLogger returns middleware that logs each HTTP request.
func RequestLogger(logger zerolog.Logger) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip logging for health endpoint
			if IsPublicUnauthenticatedPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}

			start := time.Now()

			// Wrap response writer to capture status code
			ww := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(ww, r)

			duration := time.Since(start)

			logger.Info().
				Str("method", r.Method).
				Str("path", r.URL.Path).
				Int("status", ww.statusCode).
				Dur("duration", duration).
				Int64("req_size", r.ContentLength).
				Int("resp_size", ww.bytesWritten).
				Msgf("HTTP %s %s -> %d (%.2f ms)",
					r.Method,
					r.URL.Path,
					ww.statusCode,
					float64(duration.Microseconds())/1000.0,
				)
		})
	}
}

// responseWriter wraps http.ResponseWriter to capture status code and bytes written.
type responseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter -- forwards downstream handler output
	n, err := rw.ResponseWriter.Write(b)
	rw.bytesWritten += n
	return n, err
}

func (rw *responseWriter) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

// Flush forwards to the underlying writer so streaming handlers keep working
// through the wrapper (also reachable via http.ResponseController + Unwrap).
func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack forwards to the underlying writer so handlers that need the raw
// connection (e.g. websockets) continue to function through the wrapper.
func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// APIKeyAuth returns middleware that validates API key authentication.
func APIKeyAuth(apiKey string) func(next http.Handler) http.Handler {
	apiKey = strings.TrimSpace(apiKey)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth for endpoints that authenticate outside HTTP headers.
			if SkipsAPIKeyAuthPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}

			// Empty configured key must never authenticate (SHA-256 of "" matches a missing key).
			if apiKey == "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter -- static JSON error body
				_, _ = w.Write([]byte(`{"success":false,"message":"Invalid or missing API key","error_code":"UNAUTHORIZED"}`))
				return
			}

			// Check X-API-Key header; Authorization: Bearer only when scheme matches case-insensitively.
			providedKey := strings.TrimSpace(r.Header.Get("X-API-Key"))
			if providedKey == "" {
				authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
				if idx := strings.IndexByte(authHeader, ' '); idx > 0 {
					scheme := authHeader[:idx]
					token := strings.TrimSpace(authHeader[idx+1:])
					if strings.EqualFold(scheme, "Bearer") && token != "" {
						providedKey = token
					}
				}
			}

			// Compare SHA-256 digests so length differences do not short-circuit (avoids leaking key length via timing).
			pH := sha256.Sum256([]byte(providedKey))
			eH := sha256.Sum256([]byte(apiKey))
			if subtle.ConstantTimeCompare(pH[:], eH[:]) != 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter -- static JSON error body
				_, _ = w.Write([]byte(`{"success":false,"message":"Invalid or missing API key","error_code":"UNAUTHORIZED"}`))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
