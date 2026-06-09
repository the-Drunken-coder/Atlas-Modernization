package actions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestResourceUpdatesRejectStaleExpectedVersion(t *testing.T) {
	pool, ctx, cancel := openActionsTestPool(t)
	defer cancel()
	defer pool.Close()

	runID := time.Now().UTC().UnixNano()
	entityID := fmt.Sprintf("ifmatch-entity-%d", runID)
	taskID := fmt.Sprintf("ifmatch-task-%d", runID)
	objectID := fmt.Sprintf("ifmatch-object-%d", runID)
	defer cleanupIfMatchTestRows(context.Background(), pool, entityID, taskID, objectID)

	entityActions := NewEntityActions(pool)
	taskActions := NewTaskActions(pool)
	objectActions := NewObjectActions(pool, nil)

	entity, err := entityActions.Create(ctx, CreateEntityParams{
		EntityID:   entityID,
		EntityType: "asset",
		Subtype:    "drone",
	})
	if err != nil {
		t.Fatalf("create entity: %v", err)
	}
	task, err := taskActions.Create(ctx, CreateTaskParams{
		TaskID:   taskID,
		EntityID: &entityID,
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	object, err := objectActions.Create(ctx, CreateObjectParams{
		ObjectID: objectID,
	})
	if err != nil {
		t.Fatalf("create object: %v", err)
	}

	tests := []struct {
		name string
		run  func(expectedVersion *int64) error
	}{
		{
			name: "entity",
			run: func(expectedVersion *int64) error {
				_, err := entityActions.Update(ctx, entityID, UpdateEntityParams{
					Components: map[string]interface{}{
						"telemetry": map[string]interface{}{
							"latitude":  40.0,
							"longitude": -73.0,
						},
					},
					ExpectedVersion: expectedVersion,
				})
				return err
			},
		},
		{
			name: "task",
			run: func(expectedVersion *int64) error {
				status := "acknowledged"
				_, err := taskActions.Update(ctx, taskID, UpdateTaskParams{
					Status:          &status,
					ExpectedVersion: expectedVersion,
				})
				return err
			},
		},
		{
			name: "object",
			run: func(expectedVersion *int64) error {
				objectType := "image"
				_, err := objectActions.Update(ctx, objectID, UpdateObjectParams{
					Type:            &objectType,
					ExpectedVersion: expectedVersion,
				})
				return err
			},
		},
	}

	versions := map[string]int64{
		"entity": entity.Version,
		"task":   task.Version,
		"object": object.Version,
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			staleVersion := versions[tt.name] + 1
			err := tt.run(&staleVersion)
			var preconditionErr *PreconditionFailedError
			if !errors.As(err, &preconditionErr) {
				t.Fatalf("expected PreconditionFailedError, got %T %v", err, err)
			}
		})
	}
}

func openActionsTestPool(t *testing.T) (*pgxpool.Pool, context.Context, context.CancelFunc) {
	t.Helper()

	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
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

func cleanupIfMatchTestRows(ctx context.Context, pool *pgxpool.Pool, entityID, taskID, objectID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID)
	_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID)
	_, _ = pool.Exec(ctx, `DELETE FROM objects WHERE object_id = $1`, objectID)
	_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_id = ANY($1)`, []string{entityID, taskID, objectID})
	_, _ = pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE object_id = $1`, objectID)
}
