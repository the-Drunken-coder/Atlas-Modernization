package admin

import (
	"context"
	"encoding/json"
	"errors"
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

// Serializes DB-backed admin tests that share admin_records across Go packages.
const adminRecordsTestLockKey int64 = 780078001

func TestDevelopmentAdminSeedLoginAndLogout(t *testing.T) {
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

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
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

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
		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("Login(%q) error = %v, want ErrInvalidCredentials", tc.username, err)
		}
	}
}

func TestDevelopmentAdminSeedRotatesExplicitOverride(t *testing.T) {
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin: %v", err)
	}

	account, err := service.GetAccount(ctx, "account:admin")
	if err != nil {
		t.Fatalf("get seeded account: %v", err)
	}
	if !VerifyPassword("password", account.Password) {
		t.Fatal("expected initial admin password to be the development default")
	}

	t.Setenv("ATLAS_ADMIN_PASSWORD", "changed-password")
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin again: %v", err)
	}

	account, err = service.GetAccount(ctx, "account:admin")
	if err != nil {
		t.Fatalf("get seeded account: %v", err)
	}
	if VerifyPassword("password", account.Password) {
		t.Fatal("expected explicit admin password override to replace the development default")
	}
	if !VerifyPassword("changed-password", account.Password) {
		t.Fatal("expected explicit admin password override to rotate seeded admin password")
	}
}

func TestLoginThrottleBoundary(t *testing.T) {
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin: %v", err)
	}

	now := time.Now().UTC()
	for i := 0; i < loginMaxFails; i++ {
		_, _, err := service.Login(ctx, "admin", "wrong", "198.51.100.10", now.Add(time.Duration(i)*time.Second))
		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("failure %d error = %v, want ErrInvalidCredentials", i+1, err)
		}
	}
	_, _, err := service.Login(ctx, "admin", "wrong", "198.51.100.10", now.Add(time.Duration(loginMaxFails)*time.Second))
	if !errors.Is(err, ErrTooManyAttempts) {
		t.Fatalf("post-boundary error = %v, want ErrTooManyAttempts", err)
	}
}

func TestCleanupExpiredAuthRecordsRemovesOnlyTransientExpiredRows(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	expiredAt := now.Add(-time.Minute)
	activeUntil := now.Add(time.Minute)
	revokedAt := expiredAt
	insertAdminRecord(ctx, t, pool, "session:expired-cleanup", "session", SessionRecord{ExpiresAt: expiredAt})
	insertAdminRecord(ctx, t, pool, "session:active-cleanup", "session", SessionRecord{ExpiresAt: activeUntil})
	insertAdminRecord(ctx, t, pool, "login_fail:user:expired-cleanup", "login_fail", LoginFailureRecord{Count: 1, ResetAt: expiredAt})
	insertAdminRecord(ctx, t, pool, "login_fail:user:active-cleanup", "login_fail", LoginFailureRecord{Count: 1, ResetAt: activeUntil})
	insertAdminRecord(ctx, t, pool, "account:cleanup", "account", AccountRecord{Username: "cleanup", Role: "admin"})
	insertAdminRecord(ctx, t, pool, "api_key:atlas_ak_cleanup", "api_key", APIKeyRecord{
		ID:         "atlas_ak_cleanup",
		Name:       "cleanup",
		KeyPrefix:  "atlas_ak_cleanup",
		SecretHash: "hash",
		CreatedAt:  expiredAt,
		CreatedBy:  "admin",
		RevokedAt:  &revokedAt,
	})

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.CleanupExpiredAuthRecords(ctx, now); err != nil {
		t.Fatalf("cleanup expired auth records: %v", err)
	}

	assertAdminRecordAbsent(ctx, t, pool, "session:expired-cleanup")
	assertAdminRecordPresent(ctx, t, pool, "session:active-cleanup")
	assertAdminRecordAbsent(ctx, t, pool, "login_fail:user:expired-cleanup")
	assertAdminRecordPresent(ctx, t, pool, "login_fail:user:active-cleanup")
	assertAdminRecordPresent(ctx, t, pool, "account:cleanup")
	assertAdminRecordPresent(ctx, t, pool, "api_key:atlas_ak_cleanup")
}

func TestLoginCleansExpiredAuthRecordsOpportunistically(t *testing.T) {
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if err := service.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed dev admin: %v", err)
	}
	insertAdminRecord(ctx, t, pool, "session:stale-before-login", "session", SessionRecord{ExpiresAt: now.Add(-time.Minute)})
	insertAdminRecord(ctx, t, pool, "session:active-before-login", "session", SessionRecord{ExpiresAt: now.Add(time.Minute)})
	insertAdminRecord(ctx, t, pool, "login_fail:user:stale-before-login", "login_fail", LoginFailureRecord{Count: 1, ResetAt: now.Add(-time.Minute)})
	insertAdminRecord(ctx, t, pool, "login_fail:user:active-before-login", "login_fail", LoginFailureRecord{Count: 1, ResetAt: now.Add(time.Minute)})

	if _, _, err := service.Login(ctx, "admin", "password", "127.0.0.1", now); err != nil {
		t.Fatalf("login seeded admin: %v", err)
	}

	assertAdminRecordAbsent(ctx, t, pool, "session:stale-before-login")
	assertAdminRecordPresent(ctx, t, pool, "session:active-before-login")
	assertAdminRecordAbsent(ctx, t, pool, "login_fail:user:stale-before-login")
	assertAdminRecordPresent(ctx, t, pool, "login_fail:user:active-before-login")
}

func TestAPIKeyCreateAuthenticateListAndRevoke(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	created, err := service.CreateAPIKey(ctx, "sim runner", "admin", time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("create api key: %v", err)
	}
	if !strings.HasPrefix(created.ID, apiKeyIDPrefix) {
		t.Fatalf("created key id = %q, want %s prefix", created.ID, apiKeyIDPrefix)
	}
	if !strings.HasPrefix(created.APIKey, created.ID+".") {
		t.Fatalf("created full key %q does not include id prefix %q", created.APIKey, created.ID)
	}
	if created.KeyPrefix != created.ID {
		t.Fatalf("key prefix = %q, want %q", created.KeyPrefix, created.ID)
	}

	record, err := service.getAPIKeyRecord(ctx, created.ID)
	if err != nil {
		t.Fatalf("get raw api key record: %v", err)
	}
	if strings.Contains(record.SecretHash, created.APIKey) {
		t.Fatal("stored hash should not contain the full api key")
	}
	if record.SecretHash == "" {
		t.Fatal("expected stored secret hash")
	}
	if !service.AuthenticateAPIKey(ctx, created.APIKey) {
		t.Fatal("expected created api key to authenticate")
	}
	if service.AuthenticateAPIKey(ctx, created.ID+".wrong") {
		t.Fatal("expected wrong secret to fail")
	}
	if service.AuthenticateAPIKey(ctx, "malformed") {
		t.Fatal("expected malformed key to fail")
	}
	if ok, err := service.AuthenticateAPIKeyResult(ctx, created.ID+".wrong"); err != nil || ok {
		t.Fatalf("wrong secret result = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := service.AuthenticateAPIKeyResult(ctx, "malformed"); err != nil || ok {
		t.Fatalf("malformed key result = (%v, %v), want (false, nil)", ok, err)
	}

	keys, err := service.ListAPIKeys(ctx)
	if err != nil {
		t.Fatalf("list api keys: %v", err)
	}
	if len(keys) != 1 || keys[0].ID != created.ID || keys[0].Name != "sim runner" {
		t.Fatalf("unexpected listed keys: %#v", keys)
	}

	if err := service.RevokeAPIKey(ctx, created.ID, time.Now().UTC()); err != nil {
		t.Fatalf("revoke api key: %v", err)
	}
	if service.AuthenticateAPIKey(ctx, created.APIKey) {
		t.Fatal("expected revoked api key to fail")
	}
	keys, err = service.ListAPIKeys(ctx)
	if err != nil {
		t.Fatalf("list after revoke: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("expected revoked key to be omitted, got %#v", keys)
	}
	if !errors.Is(service.RevokeAPIKey(ctx, created.ID, time.Now().UTC()), ErrAPIKeyNotFound) {
		t.Fatal("expected second revoke to return ErrAPIKeyNotFound")
	}
	if ok, err := service.AuthenticateAPIKeyResult(ctx, created.APIKey); err != nil || ok {
		t.Fatalf("revoked key result = (%v, %v), want (false, nil)", ok, err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'api_key', $2::jsonb)
	`, "api_key:atlas_ak_badjson", `"not an api key record"`); err != nil {
		t.Fatalf("insert malformed api key record: %v", err)
	}
	if ok, err := service.AuthenticateAPIKeyResult(ctx, "atlas_ak_badjson.secret"); err == nil || ok {
		t.Fatalf("malformed record result = (%v, %v), want (false, error)", ok, err)
	}
}

func TestAPIKeyCreateValidatesName(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	if _, err := service.CreateAPIKey(ctx, "   ", "admin", time.Now().UTC()); !errors.Is(err, ErrAPIKeyNameRequired) {
		t.Fatalf("blank name error = %v, want ErrAPIKeyNameRequired", err)
	}
	longName := strings.Repeat("a", apiKeyNameMaxRunes+1)
	if _, err := service.CreateAPIKey(ctx, longName, "admin", time.Now().UTC()); !errors.Is(err, ErrAPIKeyNameTooLong) {
		t.Fatalf("long name error = %v, want ErrAPIKeyNameTooLong", err)
	}
}

func TestClientIPIgnoresSpoofableForwardedHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/admin/auth/login", nil)
	req.RemoteAddr = "203.0.113.10:4242"
	req.Header.Set("CF-Connecting-IP", "198.51.100.20")
	req.Header.Set("X-Forwarded-For", "198.51.100.30, 198.51.100.31")

	if got := ClientIP(req); got != "203.0.113.10" {
		t.Fatalf("ClientIP() = %q, want remote address", got)
	}
}

func TestUsesDefaultDevelopmentPassword(t *testing.T) {
	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	if !UsesDefaultDevelopmentPassword() {
		t.Fatal("expected default development password to be active without overrides")
	}

	t.Setenv("ATLAS_ADMIN_PASSWORD", "   ")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	if !UsesDefaultDevelopmentPassword() {
		t.Fatal("expected whitespace password override to leave default development password active")
	}

	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "   ")
	if !UsesDefaultDevelopmentPassword() {
		t.Fatal("expected whitespace password file override to leave default development password active")
	}

	t.Setenv("ATLAS_ADMIN_PASSWORD", "changed-password")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
	if UsesDefaultDevelopmentPassword() {
		t.Fatal("expected explicit password to disable default development password")
	}

	t.Setenv("ATLAS_ADMIN_PASSWORD", "")
	t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "/tmp/admin-password")
	if UsesDefaultDevelopmentPassword() {
		t.Fatal("expected password file to disable default development password")
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
	lockAdminRecords(ctx, t, pool)
	return pool
}

func lockAdminRecords(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire admin_records test lock connection: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, adminRecordsTestLockKey); err != nil {
		conn.Release()
		t.Fatalf("lock admin_records tests: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanupCtx, `SELECT pg_advisory_unlock($1)`, adminRecordsTestLockKey); err != nil {
			t.Errorf("unlock admin_records tests: %v", err)
		}
		conn.Release()
	})
}

func cleanupAdminRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM admin_records`); err != nil {
		t.Fatalf("cleanup admin records: %v", err)
	}
}

func insertAdminRecord(ctx context.Context, t *testing.T, pool *pgxpool.Pool, id, recordType string, record any) {
	t.Helper()
	payload, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal admin record %s: %v", id, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, $2, $3)
	`, id, recordType, payload); err != nil {
		t.Fatalf("insert admin record %s: %v", id, err)
	}
}

func assertAdminRecordPresent(ctx context.Context, t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	if !adminRecordExists(ctx, t, pool, id) {
		t.Fatalf("expected admin record %q to be present", id)
	}
}

func assertAdminRecordAbsent(ctx context.Context, t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	if adminRecordExists(ctx, t, pool, id) {
		t.Fatalf("expected admin record %q to be absent", id)
	}
}

func adminRecordExists(ctx context.Context, t *testing.T, pool *pgxpool.Pool, id string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM admin_records WHERE id = $1)`, id).Scan(&exists); err != nil {
		t.Fatalf("check admin record %s: %v", id, err)
	}
	return exists
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
