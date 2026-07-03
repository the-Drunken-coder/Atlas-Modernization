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

	"golang.org/x/net/publicsuffix"

	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

var unauthorizedErrorBody = []byte(`{"success":false,"message":"Unauthorized","error_code":"` + string(protocol.ErrorCodeUnauthorized) + `"}`)

// IsPublicUnauthenticatedPath returns true for routes that skip protected-route auth.
func IsPublicUnauthenticatedPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	if normalized == "" {
		normalized = "/"
	}

	switch normalized {
	case "/health", "/readiness", "/resources", "/admin/auth/login":
		return true
	default:
		return false
	}
}

// RequestLogger returns middleware that logs each HTTP request.
func RequestLogger(logger zerolog.Logger) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isUnloggedHealthPath(r.URL.Path) {
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

func isUnloggedHealthPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	return normalized == "/health" || normalized == "/readiness"
}

func isLogoutPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	return normalized == "/admin/auth/logout"
}

func isAPIKeyAdminPath(path string) bool {
	normalized := strings.TrimRight(path, "/")
	return normalized == "/admin/api-keys" || strings.HasPrefix(normalized, "/admin/api-keys/")
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

func CombinedAuth(apiKey string, enableAPIKey bool, adminAuth *admin.Service, trustedOrigins []string, trustedOriginPatterns []string) func(next http.Handler) http.Handler {
	apiKey = strings.TrimSpace(apiKey)
	trusted := newTrustedOriginMatcher(trustedOrigins, trustedOriginPatterns)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions || IsPublicUnauthenticatedPath(r.URL.Path) || r.URL.Path == "/feed" {
				next.ServeHTTP(w, r)
				return
			}
			if isLogoutPath(r.URL.Path) {
				if unsafeMethod(r.Method) && !trusted.Match(r.Header.Get("Origin")) {
					writeUnauthorized(w)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if !isAPIKeyAdminPath(r.URL.Path) && enableAPIKey {
				valid, err := ValidAPIKeyOrManagedResult(r, apiKey, adminAuth)
				if err != nil {
					zerolog.Ctx(r.Context()).Warn().Err(err).Msg("managed API key authentication failed")
				}
				if valid {
					next.ServeHTTP(w, r)
					return
				}
			}
			if adminAuth != nil {
				if _, err := adminAuth.AuthenticateRequest(r.Context(), r); err == nil {
					if unsafeMethod(r.Method) && !trusted.Match(r.Header.Get("Origin")) {
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
	return validAPIKeyValue(requestAPIKey(r), apiKey)
}

func ValidAPIKeyOrManaged(r *http.Request, apiKey string, adminAuth *admin.Service) bool {
	valid, err := ValidAPIKeyOrManagedResult(r, apiKey, adminAuth)
	return err == nil && valid
}

func ValidAPIKeyOrManagedResult(r *http.Request, apiKey string, adminAuth *admin.Service) (bool, error) {
	providedKey := requestAPIKey(r)
	if validAPIKeyValue(providedKey, apiKey) {
		return true, nil
	}
	if strings.TrimSpace(providedKey) == "" || adminAuth == nil {
		return false, nil
	}
	return adminAuth.AuthenticateAPIKeyResult(r.Context(), providedKey)
}

func validAPIKeyValue(providedKey string, apiKey string) bool {
	if apiKey == "" {
		return false
	}
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
		origin = normalizeTrustedOrigin(origin)
		if origin != "" {
			out[origin] = struct{}{}
		}
	}
	return out
}

func TrustedOrigin(origin string, trustedOrigins []string) bool {
	return TrustedOriginWithPatterns(origin, trustedOrigins, nil)
}

func TrustedOriginWithPatterns(origin string, trustedOrigins []string, trustedPatterns []string) bool {
	return newTrustedOriginMatcher(trustedOrigins, trustedPatterns).Match(origin)
}

type trustedOriginMatcher struct {
	exact    map[string]struct{}
	patterns []string
}

func newTrustedOriginMatcher(origins []string, patterns []string) trustedOriginMatcher {
	matcher := trustedOriginMatcher{
		exact:    trustedOriginSet(origins),
		patterns: make([]string, 0, len(patterns)),
	}
	for _, pattern := range patterns {
		if normalized := normalizeTrustedOrigin(pattern); normalized != "" {
			matcher.patterns = append(matcher.patterns, normalized)
		}
	}
	return matcher
}

func (m trustedOriginMatcher) Match(origin string) bool {
	origin = normalizeTrustedOrigin(origin)
	if origin == "" {
		return false
	}
	if _, ok := m.exact[origin]; ok {
		return true
	}
	for _, pattern := range m.patterns {
		if originMatchesPattern(origin, pattern) {
			return true
		}
	}
	return false
}

func originMatchesPattern(origin string, pattern string) bool {
	if strings.Count(pattern, "*") != 1 {
		return false
	}
	if !isConstrainedOriginPattern(pattern) {
		return false
	}
	prefix, suffix, _ := strings.Cut(pattern, "*")
	if len(origin) <= len(prefix)+len(suffix) {
		return false
	}
	if !strings.HasPrefix(origin, prefix) || !strings.HasSuffix(origin, suffix) {
		return false
	}
	wildcardValue := strings.TrimSuffix(strings.TrimPrefix(origin, prefix), suffix)
	return !strings.Contains(wildcardValue, ".")
}

func isConstrainedOriginPattern(pattern string) bool {
	parsed, err := url.Parse(pattern)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return false
	}
	host := parsed.Hostname()
	if strings.Count(host, "*") != 1 || strings.Contains(parsed.Port(), "*") {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 3 || !strings.Contains(labels[0], "*") {
		return false
	}
	_, err = publicsuffix.EffectiveTLDPlusOne(strings.Join(labels[1:], "."))
	return err == nil
}

func normalizeTrustedOrigin(origin string) string {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return ""
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
}
