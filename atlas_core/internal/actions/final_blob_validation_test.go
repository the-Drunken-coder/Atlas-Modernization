package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
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

func TestValidateEntityBlobAcceptsValidBlob(t *testing.T) {
	err := ValidateEntityBlob(map[string]interface{}{
		"published_at": "2026-06-10T00:00:00Z",
		"callsign":     "atlas-one",
	})
	if err != nil {
		t.Fatalf("ValidateEntityBlob() unexpected error: %v", err)
	}
}

func TestUpdateEntityValidatesFinalBlobBeforeUpdate(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	actions := NewEntityActions(pool)
	entityID := fmt.Sprintf("entity-final-blob-%d", time.Now().UTC().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, entityID, "")

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
	pool := testenv.OpenDatabasePool(t, "ATLAS_ACTIONS_DATABASE_URL", "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema is not present in test database")
	}
	return pool
}

func cleanupFinalBlobValidationRows(ctx context.Context, t testing.TB, pool *pgxpool.Pool, entityID, taskID string) {
	t.Helper()
	if taskID != "" {
		if _, err := pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID); err != nil {
			t.Errorf("cleanup task row %q: %v", taskID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM atlas_change_events WHERE event->>'resource_type' = 'task' AND event->>'id' = $1`, taskID); err != nil {
			t.Errorf("cleanup task change rows %q: %v", taskID, err)
		}
	}
	if entityID != "" {
		if _, err := pool.Exec(ctx, `DELETE FROM tasks WHERE asset_id = $1`, entityID); err != nil {
			t.Errorf("cleanup tasks for entity %q: %v", entityID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID); err != nil {
			t.Errorf("cleanup entity row %q: %v", entityID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM asset_runtime_generations WHERE asset_id = $1`, entityID); err != nil {
			t.Errorf("cleanup runtime generations for entity %q: %v", entityID, err)
		}
		if _, err := pool.Exec(ctx, `
			DELETE FROM atlas_change_events
			WHERE (event->>'resource_type' = 'entity' AND event->>'id' = $1)
				OR task_asset_id = $1
		`, entityID); err != nil {
			t.Errorf("cleanup entity change rows %q: %v", entityID, err)
		}
	}
}

func cleanupFinalBlobValidationRowsWithTimeout(t testing.TB, pool *pgxpool.Pool, entityID, taskID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cleanupFinalBlobValidationRows(ctx, t, pool, entityID, taskID)
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
