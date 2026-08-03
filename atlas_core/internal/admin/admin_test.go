package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
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

func TestConcurrentLoginAdmissionCannotBypassThrottle(t *testing.T) {
	for _, tc := range []struct {
		name     string
		username func(int) string
		ip       func(int) string
	}{
		{
			name:     "username bucket",
			username: func(int) string { return "missing-admin" },
			ip:       func(i int) string { return fmt.Sprintf("198.51.100.%d", i+1) },
		},
		{
			name:     "client IP bucket",
			username: func(i int) string { return fmt.Sprintf("missing-admin-%d", i) },
			ip:       func(int) string { return "198.51.100.100" },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := openAdminTestPool(t)
			ctx := context.Background()
			cleanupAdminRows(ctx, t, pool)

			services := []*Service{
				NewService(pool, &config.Config{AdminCookieSameSite: "lax"}),
				NewService(pool, &config.Config{AdminCookieSameSite: "lax"}),
			}
			entered := make(chan struct{}, loginMaxFails+4)
			release := make(chan struct{}, loginMaxFails)
			var callsMu sync.Mutex
			verifyCalls := 0
			verifier := func(string, PasswordHash) bool {
				callsMu.Lock()
				verifyCalls++
				callsMu.Unlock()
				entered <- struct{}{}
				<-release
				return false
			}
			for _, service := range services {
				service.verifyPassword = verifier
			}

			const attempts = loginMaxFails + 4
			start := make(chan struct{})
			results := make(chan error, attempts)
			now := time.Now().UTC()
			for i := 0; i < attempts; i++ {
				go func(i int) {
					<-start
					_, _, err := services[i%len(services)].Login(ctx, tc.username(i), "wrong", tc.ip(i), now)
					results <- err
				}(i)
			}
			close(start)

			for i := 0; i < loginMaxFails; i++ {
				<-entered
				release <- struct{}{}
			}
			close(release)

			invalid, throttled := 0, 0
			for i := 0; i < attempts; i++ {
				switch err := <-results; {
				case errors.Is(err, ErrInvalidCredentials):
					invalid++
				case errors.Is(err, ErrTooManyAttempts):
					throttled++
				default:
					t.Fatalf("login error = %v, want invalid credentials or too many attempts", err)
				}
			}
			callsMu.Lock()
			gotCalls := verifyCalls
			callsMu.Unlock()
			if gotCalls != loginMaxFails || invalid != loginMaxFails || throttled != attempts-loginMaxFails {
				t.Fatalf("verification/invalid/throttled = %d/%d/%d, want %d/%d/%d", gotCalls, invalid, throttled, loginMaxFails, loginMaxFails, attempts-loginMaxFails)
			}
		})
	}
}

func TestArgon2VerificationHasProcessWideConcurrencyBound(t *testing.T) {
	slots := make(chan struct{}, 2)
	entered := make(chan struct{}, 3)
	release := make(chan struct{})
	var wg sync.WaitGroup
	var activeMu sync.Mutex
	active, maxActive := 0, 0

	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			releaseSlot, err := acquireLoginSlot(context.Background(), slots)
			if err != nil {
				t.Errorf("acquire login slot: %v", err)
				return
			}
			defer releaseSlot()
			activeMu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			activeMu.Unlock()
			entered <- struct{}{}
			<-release
			activeMu.Lock()
			active--
			activeMu.Unlock()
		}()
	}

	<-entered
	<-entered
	if got := len(slots); got != cap(slots) {
		t.Fatalf("occupied Argon2 slots = %d, want %d", got, cap(slots))
	}
	release <- struct{}{}
	<-entered
	close(release)
	wg.Wait()

	activeMu.Lock()
	gotMax := maxActive
	activeMu.Unlock()
	if gotMax > cap(slots) {
		t.Fatalf("concurrent Argon2 work = %d, limit = %d", gotMax, cap(slots))
	}
}

func TestLoginSlotWaitHonorsContextCancellation(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	release, err := acquireLoginSlot(ctx, slots)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("acquire error = %v, want context.Canceled", err)
	}
	if release != nil {
		t.Fatal("cancelled acquisition returned a release function")
	}
}

func TestLoginAcquiresSlotAfterDatabaseAdmission(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)
	for i := 0; i < cap(loginArgon2Slots); i++ {
		loginArgon2Slots <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(loginArgon2Slots); i++ {
			<-loginArgon2Slots
		}
	}()
	loginCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	go func() {
		_, _, err := service.Login(loginCtx, "admin", "wrong", "198.51.100.10", time.Now().UTC())
		result <- err
	}()

	lockID := loginAdmissionLockID("user:admin")
	deadline := time.Now().Add(5 * time.Second)
	for {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin admission probe: %v", err)
		}
		var acquired bool
		err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, lockID).Scan(&acquired)
		if rollbackErr := tx.Rollback(ctx); rollbackErr != nil {
			t.Fatalf("rollback admission probe: %v", rollbackErr)
		}
		if err != nil {
			t.Fatalf("probe login admission lock: %v", err)
		}
		if !acquired {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("login did not reach database admission while the Argon2 gate was full")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("Login error = %v, want context.Canceled while waiting for an Argon2 slot", err)
	}
}

func TestLoginUsesSamePasswordVerifierForEveryAccountState(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)

	insertAdminRecord(ctx, t, pool, "account:enabled", "account", AccountRecord{
		Username: "enabled",
		Password: PasswordHash{Hash: "enabled-hash"},
		Role:     defaultRole,
	})
	insertAdminRecord(ctx, t, pool, "account:disabled", "account", AccountRecord{
		Username: "disabled",
		Password: PasswordHash{Hash: "disabled-hash"},
		Role:     defaultRole,
		Disabled: true,
	})

	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	var hashes []string
	service.verifyPassword = func(_ string, stored PasswordHash) bool {
		hashes = append(hashes, stored.Hash)
		return false
	}
	for i, username := range []string{"missing", "enabled", "disabled"} {
		_, _, err := service.Login(ctx, username, "wrong", fmt.Sprintf("203.0.113.%d", i+1), time.Now().UTC())
		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("Login(%q) error = %v, want ErrInvalidCredentials", username, err)
		}
	}
	want := []string{dummyPasswordHash.Hash, "enabled-hash", "disabled-hash"}
	if !slices.Equal(hashes, want) {
		t.Fatalf("verified hashes = %v, want %v", hashes, want)
	}
}

func TestLoginThrottleKeepsUsernameLimitWithoutClientIP(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)
	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	now := time.Now().UTC()

	for i := 0; i < loginMaxFails; i++ {
		if err := service.recordLoginFailure(ctx, "admin", "", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("record username failure %d: %v", i+1, err)
		}
	}
	if throttled, err := service.loginThrottled(ctx, "admin", "", now.Add(time.Duration(loginMaxFails)*time.Second)); err != nil || !throttled {
		t.Fatalf("admin username throttle = (%v, %v), want (true, nil)", throttled, err)
	}
	if throttled, err := service.loginThrottled(ctx, "other-admin", "", now.Add(time.Duration(loginMaxFails)*time.Second)); err != nil || throttled {
		t.Fatalf("other username throttle = (%v, %v), want (false, nil)", throttled, err)
	}
}

func TestLoginThrottleSeparatesClientIPBuckets(t *testing.T) {
	pool := openAdminTestPool(t)
	ctx := context.Background()
	cleanupAdminRows(ctx, t, pool)
	service := NewService(pool, &config.Config{AdminCookieSameSite: "lax"})
	now := time.Now().UTC()

	for i := 0; i < loginMaxFails; i++ {
		if err := service.recordLoginFailure(ctx, fmt.Sprintf("missing-%d", i), "198.51.100.10", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("record IP failure %d: %v", i+1, err)
		}
	}
	if throttled, err := service.loginThrottled(ctx, "another-user", "198.51.100.10", now.Add(time.Duration(loginMaxFails)*time.Second)); err != nil || !throttled {
		t.Fatalf("failed client throttle = (%v, %v), want (true, nil)", throttled, err)
	}
	if throttled, err := service.loginThrottled(ctx, "another-user", "198.51.100.11", now.Add(time.Duration(loginMaxFails)*time.Second)); err != nil || throttled {
		t.Fatalf("separate client throttle = (%v, %v), want (false, nil)", throttled, err)
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

func TestClientIPRespectsTrustedProxyBoundary(t *testing.T) {
	trusted := []netip.Prefix{
		netip.MustParsePrefix("172.30.0.3/32"),
		netip.MustParsePrefix("10.0.0.0/8"),
	}
	tests := []struct {
		name       string
		remoteAddr string
		cf         []string
		xff        []string
		want       string
	}{
		{
			name:       "direct client ignores spoofed headers",
			remoteAddr: "203.0.113.10:4242",
			cf:         []string{"198.51.100.20"},
			xff:        []string{"198.51.100.30, 198.51.100.31"},
			want:       "203.0.113.10",
		},
		{
			name:       "trusted proxy uses Cloudflare client header",
			remoteAddr: "172.30.0.3:4242",
			cf:         []string{"198.51.100.20"},
			xff:        []string{"198.51.100.30"},
			want:       "198.51.100.20",
		},
		{
			name:       "IPv4-mapped proxy and client addresses use canonical IPv4 buckets",
			remoteAddr: "[::ffff:172.30.0.3]:4242",
			cf:         []string{"::ffff:198.51.100.20"},
			want:       "198.51.100.20",
		},
		{
			name:       "direct IPv6 client ignores spoofed headers",
			remoteAddr: "[2001:db8::10]:4242",
			cf:         []string{"198.51.100.20"},
			want:       "2001:db8::10",
		},
		{
			name:       "trusted proxy walks XFF from the right",
			remoteAddr: "172.30.0.3:4242",
			xff:        []string{"203.0.113.40, 10.0.0.8"},
			want:       "203.0.113.40",
		},
		{
			name:       "trusted proxy ignores untrusted XFF entries to the left of the client",
			remoteAddr: "172.30.0.3:4242",
			xff:        []string{"spoofed, 198.51.100.30"},
			want:       "198.51.100.30",
		},
		{
			name:       "malformed Cloudflare header does not become a shared proxy bucket",
			remoteAddr: "172.30.0.3:4242",
			cf:         []string{"not-an-ip"},
			xff:        []string{"198.51.100.30"},
			want:       "",
		},
		{
			name:       "duplicate Cloudflare header fails closed",
			remoteAddr: "172.30.0.3:4242",
			cf:         []string{"198.51.100.20", "198.51.100.21"},
			want:       "",
		},
		{
			name:       "malformed XFF closest hop does not become a shared proxy bucket",
			remoteAddr: "172.30.0.3:4242",
			xff:        []string{"198.51.100.30, not-an-ip"},
			want:       "",
		},
		{
			name:       "trusted proxy without a client header uses username throttling only",
			remoteAddr: "172.30.0.3:4242",
			want:       "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/admin/auth/login", nil)
			req.RemoteAddr = tt.remoteAddr
			for _, value := range tt.cf {
				req.Header.Add("CF-Connecting-IP", value)
			}
			for _, value := range tt.xff {
				req.Header.Add("X-Forwarded-For", value)
			}
			if got := ClientIP(req, trusted); got != tt.want {
				t.Fatalf("ClientIP() = %q, want %q", got, tt.want)
			}
		})
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

func TestValidateProductionAdminPassword(t *testing.T) {
	for _, password := range []string{
		"password",
		" PASSWORD ",
		"REPLACE_WITH_SECURE_ADMIN_PASSWORD",
		"replace-with-secure-admin-password",
		"your-secure-admin-password",
	} {
		t.Run(password, func(t *testing.T) {
			t.Setenv("ATLAS_ADMIN_PASSWORD", password)
			t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
			if err := ValidateProductionAdminPassword(); err == nil {
				t.Fatalf("expected committed credential %q to be rejected", password)
			}
		})
	}

	t.Run("password file placeholder", func(t *testing.T) {
		path := t.TempDir() + "/admin-password"
		if err := os.WriteFile(path, []byte("REPLACE_WITH_SECURE_ADMIN_PASSWORD\n"), 0o600); err != nil {
			t.Fatalf("write password file: %v", err)
		}
		t.Setenv("ATLAS_ADMIN_PASSWORD", "")
		t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", path)
		if err := ValidateProductionAdminPassword(); err == nil {
			t.Fatal("expected committed password-file placeholder to be rejected")
		}
	})

	t.Run("real password", func(t *testing.T) {
		t.Setenv("ATLAS_ADMIN_PASSWORD", "correct-horse-battery-staple")
		t.Setenv("ATLAS_ADMIN_PASSWORD_FILE", "")
		if err := ValidateProductionAdminPassword(); err != nil {
			t.Fatalf("real password rejected: %v", err)
		}
	})
}

func openAdminTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicit := adminTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed admin tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicit {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		if explicit {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if _, err := pool.Exec(ctx, `SELECT 1 FROM admin_records LIMIT 1`); err != nil {
		testenv.SkipOrFatal(t, "admin_records table is not present: %v", err)
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
