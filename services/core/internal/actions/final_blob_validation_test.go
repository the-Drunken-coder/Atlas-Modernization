package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	atlasdb "github.com/the-drunken-coder/atlas/services/core/internal/database"
	"github.com/the-drunken-coder/atlas/services/core/internal/testenv"
)

func TestCreateEntityValidatesFinalBlobBeforeInsert(t *testing.T) {
	actions := NewEntityActions(nil)

	_, err := actions.Create(context.Background(), CreateEntityParams{
		EntityID:   "bad-entity-blob",
		EntityType: "asset",
		Extra: map[string]interface{}{
			"published_at": "2026-13-10T00:00:00Z",
		},
	})

	assertValidationDetailsContain(t, err, "published_at")
}

func TestUpdateEntityValidatesFinalBlobBeforeUpdate(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	actions := NewEntityActions(pool)
	entityID := fmt.Sprintf("entity-final-blob-%d", time.Now().UTC().UnixNano())

	if _, err := actions.Create(ctx, CreateEntityParams{
		EntityID:   entityID,
		EntityType: "asset",
	}); err != nil {
		t.Fatalf("create entity fixture: %v", err)
	}

	_, err := actions.Update(ctx, entityID, UpdateEntityParams{
		Extra: map[string]interface{}{
			"published_at": "2026-13-10T00:00:00Z",
		},
	})

	assertValidationDetailsContain(t, err, "published_at")
}

func openActionsTestPool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	pool, _ := openIsolatedActionsTestPool(t)
	return pool
}

func openIsolatedActionsTestPool(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	dbURL := testenv.IsolatedDatabaseURL(t, "ATLAS_ACTIONS_DATABASE_URL", "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	return openActionsTestPoolAtURL(t, dbURL), dbURL
}

func openActionsTestPoolAtURL(t testing.TB, dbURL string) *pgxpool.Pool {
	t.Helper()
	db, err := atlasdb.New(&config.Config{
		DatabaseURL:             dbURL,
		DatabasePoolSize:        5,
		DatabaseMaxOverflow:     10,
		DatabasePoolRecycle:     3600,
		DatabasePoolTimeout:     10,
		DatabasePoolIdleTimeout: 30,
		DatabasePoolPrePing:     false,
	})
	if err != nil {
		t.Fatalf("open isolated action test database: %v", err)
	}
	t.Cleanup(db.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("initialize isolated action test schema: %v", err)
	}
	return db.Pool
}

func assertValidationDetailsContain(t *testing.T, err error, want string) {
	t.Helper()
	var validationErr *ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("error = %T %v, want ValidationError", err, err)
	}
	for _, detail := range validationErr.Details {
		if strings.Contains(detail, want) {
			return
		}
	}
	t.Fatalf("validation details = %v, want detail containing %q", validationErr.Details, want)
}
