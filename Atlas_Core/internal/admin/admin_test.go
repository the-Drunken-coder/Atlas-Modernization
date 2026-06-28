package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestDevelopmentAdminSeedLoginAndLogout(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(t, ctx, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin: %v", err)
	}

	account, err := service.GetAccount(ctx, "account:admin")
	if err != nil {
		t.Fatalf("get seeded account: %v", err)
	}
	if account.Username != "admin" || account.Role != "admin" || account.Disabled {
		t.Fatalf("unexpected seeded account: %#v", account)
	}
	if account.Password.Algorithm != "argon2id" || strings.Contains(account.Password.Hash, "password") {
		t.Fatalf("seeded password was not stored as an Argon2id hash: %#v", account.Password)
	}

	token, session, err := service.Login(ctx, "admin", "password", "127.0.0.1", time.Now().UTC())
	if err != nil {
		t.Fatalf("login seeded admin: %v", err)
	}
	rec := httptest.NewRecorder()
	service.SetSessionCookie(rec, token, session.ExpiresAt)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("unexpected session cookie: %#v", cookies)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin/auth/me", nil)
	req.AddCookie(cookies[0])
	authenticated, err := service.AuthenticateRequest(ctx, req)
	if err != nil {
		t.Fatalf("authenticate session: %v", err)
	}
	if authenticated.Username != "admin" {
		t.Fatalf("authenticated username = %q", authenticated.Username)
	}
	if err := service.Logout(ctx, req); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := service.AuthenticateRequest(ctx, req); err == nil {
		t.Fatal("expected logged-out session to be rejected")
	}
}

func TestInvalidLoginFailuresShareUnauthorizedShapeAtServiceBoundary(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(t, ctx, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin: %v", err)
	}

	for _, tc := range []struct {
		username string
		password string
	}{
		{"missing", "password"},
		{"admin", "wrong"},
	} {
		_, _, err := service.Login(ctx, tc.username, tc.password, "127.0.0.1", time.Now().UTC())
		if err != ErrInvalidCredentials {
			t.Fatalf("Login(%q) error = %v, want ErrInvalidCredentials", tc.username, err)
		}
	}
}

func openAdminTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicit := adminTestDatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed admin tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicit {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		if explicit {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if _, err := pool.Exec(ctx, `SELECT 1 FROM admin_records LIMIT 1`); err != nil {
		t.Skipf("admin_records table is not present: %v", err)
	}
	return pool
}

func cleanupAdminRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM admin_records`); err != nil {
		t.Fatalf("cleanup admin records: %v", err)
	}
}

func adminTestDatabaseURL() (string, bool) {
	if dbURL := os.Getenv("ATLAS_ACTIONS_DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	if password == "" {
		return "", false
	}
	dbURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword("atlas", password),
		Host:   "localhost:5432",
		Path:   "/atlas_core",
	}
	return dbURL.String(), false
}
