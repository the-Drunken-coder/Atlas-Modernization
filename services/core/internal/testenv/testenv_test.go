package testenv

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const testenvDatabaseMessage = "set ATLAS_DATABASE_TEST_URL, DATABASE_URL, or POSTGRES_PASSWORD to run test environment integration tests"

func TestIsolatedDatabaseSchemasDoNotShareData(t *testing.T) {
	firstURL := IsolatedDatabaseURL(t, "ATLAS_DATABASE_TEST_URL", testenvDatabaseMessage)
	secondURL := IsolatedDatabaseURL(t, "ATLAS_DATABASE_TEST_URL", testenvDatabaseMessage)
	first := openTestPool(t, firstURL)
	second := openTestPool(t, secondURL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for _, fixture := range []struct {
		pool  *pgxpool.Pool
		value string
	}{{first, "first"}, {second, "second"}} {
		if _, err := fixture.pool.Exec(ctx, `CREATE TABLE isolation_probe (value TEXT NOT NULL)`); err != nil {
			t.Fatalf("create isolation probe: %v", err)
		}
		if _, err := fixture.pool.Exec(ctx, `INSERT INTO isolation_probe (value) VALUES ($1)`, fixture.value); err != nil {
			t.Fatalf("insert isolation probe: %v", err)
		}
	}

	for _, fixture := range []struct {
		pool *pgxpool.Pool
		want string
	}{{first, "first"}, {second, "second"}} {
		var got string
		if err := fixture.pool.QueryRow(ctx, `SELECT value FROM isolation_probe`).Scan(&got); err != nil {
			t.Fatalf("read isolation probe: %v", err)
		}
		if got != fixture.want {
			t.Fatalf("isolated schema value = %q, want %q", got, fixture.want)
		}
	}
}

func TestIsolatedDatabaseSchemaIsDroppedAtTestCleanup(t *testing.T) {
	admin := OpenDatabasePool(t, "ATLAS_DATABASE_TEST_URL", testenvDatabaseMessage)
	var schema string
	t.Run("fixture", func(t *testing.T) {
		dbURL := IsolatedDatabaseURL(t, "ATLAS_DATABASE_TEST_URL", testenvDatabaseMessage)
		pool := openTestPool(t, dbURL)
		if err := pool.QueryRow(t.Context(), `SELECT current_schema()`).Scan(&schema); err != nil {
			t.Fatalf("read isolated schema name: %v", err)
		}
	})

	var remaining *string
	if err := admin.QueryRow(t.Context(), `SELECT to_regnamespace($1)::text`, schema).Scan(&remaining); err != nil {
		t.Fatalf("check isolated schema cleanup: %v", err)
	}
	if remaining != nil {
		t.Fatalf("isolated schema %q remains after test cleanup", schema)
	}
}

func openTestPool(t *testing.T, dbURL string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), dbURL)
	if err != nil {
		t.Fatalf("open isolated test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Fatalf("ping isolated test pool: %v", err)
	}
	return pool
}
