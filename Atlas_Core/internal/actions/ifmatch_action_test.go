package actions_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/actionstest"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/entityactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/objectactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/taskactions"
)

func TestResourceUpdatesRejectStaleExpectedVersion(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	runID := time.Now().UTC().UnixNano()
	entityID := fmt.Sprintf("ifmatch-entity-%d", runID)
	taskID := fmt.Sprintf("ifmatch-task-%d", runID)
	objectID := fmt.Sprintf("ifmatch-object-%d", runID)
	defer cleanupIfMatchTestRows(context.Background(), pool, entityID, taskID, objectID)

	entityActions := entityactions.New(pool)
	taskActions := taskactions.New(pool)
	objectActions := objectactions.New(pool, nil)

	entity, err := entityActions.Create(ctx, entityactions.CreateParams{
		EntityID:   entityID,
		EntityType: "asset",
		Subtype:    "drone",
	})
	if err != nil {
		t.Fatalf("create entity: %v", err)
	}
	task, err := taskActions.Create(ctx, taskactions.CreateParams{
		TaskID:   taskID,
		EntityID: &entityID,
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	object, err := objectActions.Create(ctx, objectactions.CreateParams{
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
				_, err := entityActions.Update(ctx, entityID, entityactions.UpdateParams{
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
				_, err := taskActions.Update(ctx, taskID, taskactions.UpdateParams{
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
				_, err := objectActions.Update(ctx, objectID, objectactions.UpdateParams{
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
			var preconditionErr *actions.PreconditionFailedError
			if !errors.As(err, &preconditionErr) {
				t.Fatalf("expected PreconditionFailedError, got %T %v", err, err)
			}
		})
	}
}

func cleanupIfMatchTestRows(ctx context.Context, pool *pgxpool.Pool, entityID, taskID, objectID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID)
	_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID)
	_, _ = pool.Exec(ctx, `DELETE FROM objects WHERE object_id = $1`, objectID)
	_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_id = ANY($1)`, []string{entityID, taskID, objectID})
	_, _ = pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE object_id = $1`, objectID)
}
