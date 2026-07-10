// HTTP middleware tests for Atlas Core.
// Chi response compression: production uses github.com/go-chi/chi/v5/middleware.Compress(5)
// in cmd/atlas_core/main.go — keep gzip tests on that stack, not a separate wrapper.
package middleware_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
)

func decodeJSONBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}
	return body
}

func TestIsPublicUnauthenticatedPathNormalizesTrailingSlashes(t *testing.T) {
	tests := map[string]bool{
		"/health":                    true,
		"/health/":                   true,
		"/health///":                 true,
		"/readiness":                 true,
		"/readiness/":                true,
		"/resources":                 false,
		"/resources/":                false,
		"/":                          false,
		"/entities/":                 false,
		"/health/live":               false,
		"/admin/auth/login":          true,
		"/admin/auth/login/":         true,
		"/admin/auth/me":             false,
		"/admin/auth/logout":         false,
		"/admin/auth/reset-password": false,
	}

	for path, want := range tests {
		t.Run(path, func(t *testing.T) {
			if got := middleware.IsPublicUnauthenticatedPath(path); got != want {
				t.Fatalf("IsPublicUnauthenticatedPath(%q) = %v, want %v", path, got, want)
			}
		})
	}
}

func TestRequestLoggerSkipsHealthAndReadiness(t *testing.T) {
	tests := []string{"/health", "/health/", "/readiness", "/readiness/"}

	for _, path := range tests {
		t.Run(path, func(t *testing.T) {
			var logBuf bytes.Buffer
			logger := zerolog.New(&logBuf)
			called := false

			handler := middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if !called {
				t.Fatal("expected wrapped handler to be called")
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", rec.Code)
			}
			if logBuf.Len() != 0 {
				t.Fatalf("expected no log output for %s, got %q", path, logBuf.String())
			}
		})
	}
}

func TestRequestLoggerLogsRootPath(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)

	handler := middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(logBuf.String(), `"path":"/"`) {
		t.Fatalf("expected root request to be logged, got %q", logBuf.String())
	}
}

func TestRequestLoggerLogsAdminLogin(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)

	handler := middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))

	req := httptest.NewRequest(http.MethodPost, "/admin/auth/login", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if !strings.Contains(logBuf.String(), `"path":"/admin/auth/login"`) {
		t.Fatalf("expected login request to be logged, got %q", logBuf.String())
	}
}

func TestRequestLoggerLogsMethodPathStatusAndResponseSize(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)

	handler := middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("test response"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	logLine := logBuf.String()
	for _, expected := range []string{`"method":"GET"`, `"path":"/entities"`, `"status":201`, `"resp_size":13`} {
		if !strings.Contains(logLine, expected) {
			t.Fatalf("expected log output to contain %s, got %q", expected, logLine)
		}
	}
}

func TestRequestLoggerPropagatesRequestID(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)

	handler := chimw.RequestID(middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		zerolog.Ctx(r.Context()).Warn().Msg("downstream warning")
		w.WriteHeader(http.StatusOK)
	})))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	req.Header.Set(chimw.RequestIDHeader, "request-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := strings.Count(logBuf.String(), `"request_id":"request-123"`); got != 2 {
		t.Fatalf("expected downstream and completion logs to carry request ID, got %d in %q", got, logBuf.String())
	}
}

func TestRequestLoggerPropagatesRequestIDWithoutLoggingReadinessRequest(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)

	handler := chimw.RequestID(middleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		zerolog.Ctx(r.Context()).Warn().Msg("readiness warning")
		w.WriteHeader(http.StatusServiceUnavailable)
	})))

	req := httptest.NewRequest(http.MethodGet, "/readiness", nil)
	req.Header.Set(chimw.RequestIDHeader, "readiness-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	logLine := logBuf.String()
	if !strings.Contains(logLine, `"request_id":"readiness-123"`) {
		t.Fatalf("expected readiness warning to carry request ID, got %q", logLine)
	}
	if strings.Contains(logLine, `"message":"HTTP GET /readiness`) {
		t.Fatalf("expected readiness completion log to remain suppressed, got %q", logLine)
	}
}

func TestRecovererLogsPanicWithRequestID(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)
	handler := chimw.RequestID(middleware.RequestLogger(logger)(middleware.Recoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))))

	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	req.Header.Set(chimw.RequestIDHeader, "panic-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
	logs := logBuf.String()
	for _, expected := range []string{`"level":"error"`, `"request_id":"panic-123"`, `"panic":"boom"`, `"message":"HTTP handler panic"`} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("expected panic log to contain %s, got %q", expected, logs)
		}
	}
}

func TestRecovererPreservesAbortHandlerPanic(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("expected http.ErrAbortHandler panic, got %v", recovered)
		}
	}()

	handler := middleware.Recoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/abort", nil))
}

func TestCombinedAuthValidKeyCallsNextHandler(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	req.Header.Set("X-API-Key", "test-secret-key")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected next handler to be called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestCombinedAuthRejectsInvalidKeyAndDoesNotCallNext(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	req.Header.Set("X-API-Key", "wrong-key")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected next handler to be blocked")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}

	body := decodeJSONBody(t, rec)
	if body["error_code"] != "UNAUTHORIZED" {
		t.Fatalf("expected UNAUTHORIZED code, got %v", body["error_code"])
	}
	if body["success"] != false {
		t.Fatalf("expected success=false, got %v", body["success"])
	}
}

func TestCombinedAuthAcceptsBearerToken(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	req.Header.Set("Authorization", "Bearer test-secret-key")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected bearer token to authorize request")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestCombinedAuthAcceptsBearerTokenCaseInsensitiveScheme(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("secret", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	req.Header.Set("Authorization", "bearer secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected lowercase bearer scheme to authorize")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestCombinedAuthRejectsAPIKeyForAdminAPIKeyRoutes(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/admin/api-keys", nil)
	req.Header.Set("X-API-Key", "test-secret-key")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected API key to be blocked from key-management routes")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCombinedAuthSkipsHealthAndReadiness(t *testing.T) {
	tests := []string{"/health", "/health/", "/readiness", "/readiness/"}

	for _, path := range tests {
		t.Run(path, func(t *testing.T) {
			called := false
			handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if !called {
				t.Fatal("expected next handler to be called")
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", rec.Code)
			}
		})
	}
}

func TestCombinedAuthProtectsRootPath(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected root path to require authentication")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCombinedAuthProtectsResourcesBeforeHandler(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("test-secret-key", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/resources", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected resources handler to be blocked before collecting host metrics")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	authorizedReq := httptest.NewRequest(http.MethodGet, "/resources", nil)
	authorizedReq.Header.Set("X-API-Key", "test-secret-key")
	authorizedRec := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRec, authorizedReq)

	if !called {
		t.Fatal("expected authenticated request to reach resources handler")
	}
	if authorizedRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorizedRec.Code)
	}
}

func TestCombinedAuthEmptyConfiguredKeyRejectsProtectedRoutes(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/entities", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected next handler to be blocked when configured API key is empty")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCombinedAuthEmptyConfiguredKeyStillAllowsPublicPaths(t *testing.T) {
	for _, path := range []string{"/health", "/health/", "/readiness", "/readiness/"} {
		t.Run(path, func(t *testing.T) {
			called := false
			handler := middleware.CombinedAuth("", true, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if !called {
				t.Fatal("expected public path to bypass auth even with empty configured key")
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", rec.Code)
			}
		})
	}
}

func TestCombinedAuthAllowsLogoutFromTrustedOriginWithoutSession(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("", false, nil, []string{"https://ui.test"}, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/admin/auth/logout", nil)
	req.Header.Set("Origin", "https://ui.test")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected trusted-origin logout to reach handler")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
}

func TestCombinedAuthRejectsLogoutFromUntrustedOrigin(t *testing.T) {
	called := false
	handler := middleware.CombinedAuth("", false, nil, []string{"https://ui.test"}, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/admin/auth/logout", nil)
	req.Header.Set("Origin", "https://evil.test")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("expected untrusted-origin logout to be blocked")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestTrustedOriginRequiresConfiguredOrigin(t *testing.T) {
	origins := []string{"http://localhost:5173", "https://atlas.example:8443"}

	if !middleware.TrustedOrigin("https://atlas.example:8443", origins) {
		t.Fatal("expected configured origin to be allowed")
	}
	if middleware.TrustedOrigin("http://atlas.example:8443", origins) {
		t.Fatal("expected origin with the wrong scheme to be rejected")
	}
	if middleware.TrustedOrigin("https://evil.example", origins) {
		t.Fatal("expected unconfigured origin to be rejected")
	}
	if middleware.TrustedOrigin("", origins) {
		t.Fatal("expected missing origin to be rejected")
	}
	if middleware.TrustedOrigin("https://atlas.example:8443", nil) {
		t.Fatal("expected empty origin list to reject session-cookie auth")
	}
	if middleware.TrustedOrigin("https://atlas.example:8443/path", origins) {
		t.Fatal("expected non-origin request value to be rejected")
	}
	if middleware.TrustedOrigin("https://atlas.example:8443", []string{"https://atlas.example:8443/path"}) {
		t.Fatal("expected non-origin trusted value to be rejected")
	}
}

func TestTrustedOriginWithPatternsAllowsConstrainedPreviewOrigin(t *testing.T) {
	origins := []string{"https://atlasinterface.com"}
	patterns := []string{"https://*.atlas-je0.pages.dev"}

	if !middleware.TrustedOriginWithPatterns("https://atlasinterface.com", origins, patterns) {
		t.Fatal("expected exact production origin to be allowed")
	}
	if !middleware.TrustedOriginWithPatterns("https://pr-123.atlas-je0.pages.dev", origins, patterns) {
		t.Fatal("expected matching Cloudflare preview origin to be allowed")
	}
	if middleware.TrustedOriginWithPatterns("https://atlas-je0.pages.dev", origins, patterns) {
		t.Fatal("expected empty wildcard match to be rejected")
	}
	if middleware.TrustedOriginWithPatterns("https://pr-123.atlas-je0.pages.dev.evil.test", origins, patterns) {
		t.Fatal("expected suffix lookalike origin to be rejected")
	}
	if middleware.TrustedOriginWithPatterns("https://evil.test", origins, patterns) {
		t.Fatal("expected unrelated origin to be rejected")
	}
	if middleware.TrustedOriginWithPatterns("https://extra.pr-123.atlas-je0.pages.dev", origins, patterns) {
		t.Fatal("expected extra subdomain label in wildcard slot to be rejected")
	}
}

func TestTrustedOriginWithPatternsRejectsBroadWildcardPattern(t *testing.T) {
	if middleware.TrustedOriginWithPatterns(
		"https://any.workers.dev",
		nil,
		[]string{"https://*.workers.dev"},
	) {
		t.Fatal("expected broad wildcard pattern to be rejected")
	}
	if middleware.TrustedOriginWithPatterns(
		"https://feature.pages.dev",
		nil,
		[]string{"https://*.pages.dev"},
	) {
		t.Fatal("expected public-suffix Pages wildcard pattern to be rejected")
	}
	if middleware.TrustedOriginWithPatterns(
		"https://pr-demo.github.io",
		nil,
		[]string{"https://pr-*.github.io"},
	) {
		t.Fatal("expected public-suffix wildcard pattern to be rejected")
	}
}

// TestChiCompressMatchesMainRouter asserts the same Chi Compress middleware and level as main.go:
//
//	r.Use(middleware.Compress(5))
func TestChiCompressMatchesMainRouter(t *testing.T) {
	payload := strings.Repeat("x", 256)
	handler := chimw.Compress(5)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// chi only compresses responses with an allowed Content-Type (see middleware doc).
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("expected Content-Encoding gzip, got %q", got)
	}
	if rec.Body.Len() >= len(payload) {
		t.Fatalf("expected compressed body smaller than %d, got %d", len(payload), rec.Body.Len())
	}
}
