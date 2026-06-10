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

func TestUpdateEntityValidatesFinalBlobBeforeUpdate(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	actions := NewEntityActions(pool)
	entityID := fmt.Sprintf("entity-final-blob-%d", time.Now().UTC().UnixNano())
	defer cleanupFinalBlobValidationRows(context.Background(), pool, entityID, "")

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
	defer cleanupFinalBlobValidationRows(context.Background(), pool, "", taskID)

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
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		t.Skip("core schema is not present in test database")
	}
	return pool
}

func cleanupFinalBlobValidationRows(ctx context.Context, pool *pgxpool.Pool, entityID, taskID string) {
	if taskID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID)
		_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_type = 'task' AND resource_id = $1`, taskID)
	}
	if entityID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE entity_id = $1`, entityID)
		_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID)
		_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_type = 'entity' AND resource_id = $1`, entityID)
	}
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
