// Package testenv contains helpers for tests that skip locally or fail in required integration modes.
package testenv

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const requireLiveTestsEnv = "ATLAS_CORE_REQUIRE_LIVE_TESTS"

// RequireLiveTests reports whether live DB/API/storage tests must fail instead
// of skipping when their dependencies are unavailable.
func RequireLiveTests() bool {
	value := strings.TrimSpace(os.Getenv(requireLiveTestsEnv))
	return value == "1" || strings.EqualFold(value, "true")
}

// SkipOrFatal skips in normal local runs and fails in the live integration tier.
func SkipOrFatal(t testing.TB, format string, args ...any) {
	t.Helper()
	if RequireLiveTests() {
		t.Fatalf(format, args...)
	}
	t.Skipf(format, args...)
}

// DatabaseURL returns the configured test database URL. A URL from an
// environment variable is explicit; the password-derived local URL is not.
func DatabaseURL(primaryEnv string) (string, bool) {
	if dbURL := os.Getenv(primaryEnv); dbURL != "" {
		return dbURL, true
	}
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	if password == "" {
		return "", false
	}
	return (&url.URL{
		Scheme: "postgres",
		User:   url.UserPassword("atlas", password),
		Host:   "localhost:5432",
		Path:   "/atlas_core",
	}).String(), false
}

// IsolatedDatabaseURL creates a private PostgreSQL schema for one test and
// returns a URL whose search path selects it. The schema is dropped after the
// test's later cleanup handlers close their pools.
func IsolatedDatabaseURL(t testing.TB, primaryEnv, missingMessage string) string {
	t.Helper()
	dbURL, explicit := DatabaseURL(primaryEnv)
	if dbURL == "" {
		SkipOrFatal(t, "%s", missingMessage)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	adminConn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		if explicit {
			t.Fatalf("connect test database: %v", err)
		}
		SkipOrFatal(t, "test database unavailable: %v", err)
	}

	schema := "atlas_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := adminConn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = adminConn.Close(context.Background())
		if explicit {
			t.Fatalf("create isolated test schema: %v", err)
		}
		SkipOrFatal(t, "test database unavailable: %v", err)
	}
	t.Logf("isolated PostgreSQL schema: %s", schema)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := adminConn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated test schema %s: %v", schema, err)
		}
		if err := adminConn.Close(cleanupCtx); err != nil {
			t.Errorf("close test database connection: %v", err)
		}
	})

	parsed, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse test database URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// OpenDatabasePool opens and pings the shared test database. Bad configured
// URLs fail immediately; an unavailable inferred local database may skip.
func OpenDatabasePool(t testing.TB, primaryEnv, missingMessage string) *pgxpool.Pool {
	t.Helper()
	dbURL, explicit := DatabaseURL(primaryEnv)
	if dbURL == "" {
		SkipOrFatal(t, "%s", missingMessage)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicit {
			t.Fatalf("connect test database: %v", err)
		}
		SkipOrFatal(t, "test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		if explicit {
			t.Fatalf("ping test database: %v", err)
		}
		SkipOrFatal(t, "test database unavailable: %v", err)
	}
	return pool
}
