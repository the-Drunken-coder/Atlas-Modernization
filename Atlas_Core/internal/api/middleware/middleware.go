// Package middleware provides HTTP middleware for the Atlas Core API.
package middleware

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

var unauthorizedErrorBody = []byte(`{"success":false,"message":"Unauthorized","error_code":"` + string(protocol.ErrorCodeUnauthorized) + `"}`)

// IsPublicUnauthenticatedPath returns true for routes that skip request logging and protected-route auth.
func IsPublicUnauthenticatedPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	if normalized == "" {
		normalized = "/"
	}

	switch normalized {
	case "/health", "/readiness":
		return true
	default:
		return strings.HasPrefix(normalized, "/admin/auth/")
	}
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

func CombinedAuth(apiKey string, enableAPIKey bool, adminAuth *admin.Service, trustedOrigins []string) func(next http.Handler) http.Handler {
	apiKey = strings.TrimSpace(apiKey)
	trusted := trustedOriginSet(trustedOrigins)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions || IsPublicUnauthenticatedPath(r.URL.Path) || r.URL.Path == "/feed" {
				next.ServeHTTP(w, r)
				return
			}
			if enableAPIKey && ValidAPIKey(r, apiKey) {
				next.ServeHTTP(w, r)
				return
			}
			if adminAuth != nil {
				if _, err := adminAuth.AuthenticateRequest(r.Context(), r); err == nil {
					if unsafeMethod(r.Method) && !trustedOrigin(r.Header.Get("Origin"), trusted) {
						writeUnauthorized(w)
						return
					}
					next.ServeHTTP(w, r)
					return
				}
			}
			writeUnauthorized(w)
		})
	}
}

func ValidAPIKey(r *http.Request, apiKey string) bool {
	if apiKey == "" {
		return false
	}
	providedKey := requestAPIKey(r)
	pH := sha256.Sum256([]byte(providedKey))
	eH := sha256.Sum256([]byte(apiKey))
	return subtle.ConstantTimeCompare(pH[:], eH[:]) == 1
}

func requestAPIKey(r *http.Request) string {
	providedKey := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if providedKey != "" {
		return providedKey
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if idx := strings.IndexByte(authHeader, ' '); idx > 0 {
		scheme := authHeader[:idx]
		token := strings.TrimSpace(authHeader[idx+1:])
		if strings.EqualFold(scheme, "Bearer") && token != "" {
			return token
		}
	}
	return ""
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	// nosemgrep: go.lang.security.audit.xss.no-direct-write-to-responsewriter.no-direct-write-to-responsewriter -- static JSON error body
	_, _ = w.Write(unauthorizedErrorBody)
}

func unsafeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func trustedOriginSet(origins []string) map[string]struct{} {
	out := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin != "" {
			out[origin] = struct{}{}
		}
	}
	return out
}

func trustedOrigin(origin string, trusted map[string]struct{}) bool {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return false
	}
	if _, ok := trusted[origin]; ok {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	normalized := parsed.Scheme + "://" + parsed.Host
	_, ok := trusted[normalized]
	return ok
}
