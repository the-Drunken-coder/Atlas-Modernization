package actions

import (
	"context"
	"errors"
	"fmt"
	"math"
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

func TestCreateTaskValidatesFinalBlobBeforeInsert(t *testing.T) {
	actions := NewTaskActions(nil)

	_, err := actions.Create(context.Background(), CreateTaskParams{
		TaskID: "bad-task-blob",
		Status: "pending",
		Extra: map[string]interface{}{
			"bad_number": math.NaN(),
		},
	})

	assertValidationDetailsContain(t, err, "bad_number: must be finite")
}

func TestValidateTaskBlobAcceptsValidBlob(t *testing.T) {
	err := ValidateTaskBlob(map[string]interface{}{
		"priority": "normal",
		"score":    1.5,
	})
	if err != nil {
		t.Fatalf("ValidateTaskBlob() unexpected error: %v", err)
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

func TestUpdateTaskValidatesFinalBlobBeforeUpdate(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	actions := NewTaskActions(pool)
	taskID := fmt.Sprintf("task-final-blob-%d", time.Now().UTC().UnixNano())
	defer cleanupFinalBlobValidationRowsWithTimeout(t, pool, "", taskID)

	if _, err := actions.Create(ctx, CreateTaskParams{
		TaskID: taskID,
		Status: "pending",
	}); err != nil {
		t.Fatalf("create task fixture: %v", err)
	}

	_, err := actions.Update(ctx, taskID, UpdateTaskParams{
		Extra: map[string]interface{}{
			"bad_number": math.NaN(),
		},
	})

	assertValidationDetailsContain(t, err, "bad_number: must be finite")
}

func openActionsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema is not present in test database")
	}
	return pool
}

func cleanupFinalBlobValidationRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool, entityID, taskID string) {
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
		if _, err := pool.Exec(ctx, `DELETE FROM tasks WHERE entity_id = $1`, entityID); err != nil {
			t.Errorf("cleanup tasks for entity %q: %v", entityID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID); err != nil {
			t.Errorf("cleanup entity row %q: %v", entityID, err)
		}
		if _, err := pool.Exec(ctx, `
			DELETE FROM atlas_change_events
			WHERE (event->>'resource_type' = 'entity' AND event->>'id' = $1)
				OR before_task_entity_id = $1
				OR after_task_entity_id = $1
		`, entityID); err != nil {
			t.Errorf("cleanup entity change rows %q: %v", entityID, err)
		}
	}
}

func cleanupFinalBlobValidationRowsWithTimeout(t *testing.T, pool *pgxpool.Pool, entityID, taskID string) {
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
