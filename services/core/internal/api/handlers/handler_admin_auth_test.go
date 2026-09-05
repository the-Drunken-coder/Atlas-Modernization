package handlers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
)

func TestAdminLogoutClearsCookieAndReportsRevocationFailure(t *testing.T) {
	poolConfig, err := pgxpool.ParseConfig("postgres://atlas.test/atlas")
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	poolConfig.MinConns = 0
	poolConfig.MaxConns = 1
	poolConfig.ConnConfig.DialFunc = func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("forced database connection failure")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	defer pool.Close()

	cfg := &config.Config{
		CORSOrigins: []string{"https://ui.test"},
	}
	handler := &Handler{
		logger:    zerolog.Nop(),
		config:    cfg,
		adminAuth: admin.NewService(pool, cfg),
	}
	req := routeRequest(http.MethodPost, "/admin/auth/logout", "")
	req.Header.Set("Origin", "https://ui.test")
	req.AddCookie(&http.Cookie{
		Name:     admin.CookieName,
		Value:    "retained-session-token",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	rec := httptest.NewRecorder()

	handler.AdminLogout(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
	body := decodeBody(t, rec)
	if body["message"] != "admin logout failed" {
		t.Fatalf("message = %v, want admin logout failed", body["message"])
	}
	if body["error_code"] != "INTERNAL_SERVER_ERROR" {
		t.Fatalf("error_code = %v, want INTERNAL_SERVER_ERROR", body["error_code"])
	}

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("response cookies = %d, want one clearing cookie", len(cookies))
	}
	if cookie := cookies[0]; cookie.Name != admin.CookieName || cookie.Value != "" || cookie.MaxAge != -1 {
		t.Fatalf("clearing cookie = %+v, want empty %s cookie with MaxAge=-1", cookie, admin.CookieName)
	}
}
