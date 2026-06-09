// Package actionstest provides shared test helpers for the action packages:
// DB-backed test pool setup and protocol validation message matching. It must
// not import the actions packages so both internal and external tests can use it.
package actionstest

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DatabaseURL resolves the test database URL and whether it was set explicitly.
func DatabaseURL() (string, bool) {
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

// OpenPool connects to the test database with the core schema present, or
// skips the test when no usable database is available.
func OpenPool(t *testing.T) (*pgxpool.Pool, context.Context, context.CancelFunc) {
	t.Helper()

	if os.Getenv("ATLAS_CORE_API_URL") != "" {
		t.Skip("skipping DB-backed action tests against the shared integration stack database")
	}

	dbURL, explicitDBURL := DatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		cancel()
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		cancel()
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if ok, err := coreSchemaPresent(ctx, pool); err != nil {
		pool.Close()
		cancel()
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		pool.Close()
		cancel()
		t.Skip("core schema is not present in test database")
	}
	return pool, ctx, cancel
}

func coreSchemaPresent(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.entities') IS NOT NULL
			AND to_regclass('public.tasks') IS NOT NULL
			AND to_regclass('public.objects') IS NOT NULL
			AND to_regclass('public.deletions') IS NOT NULL
			AND to_regclass('public.storage_deletion_outbox') IS NOT NULL
	`).Scan(&ok)
	return ok, err
}
