package actions_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/actionstest"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/entityactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/taskactions"
)

func TestEntityCreateAndUpdateValidateFinalStoredBlob(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	entityID := fmt.Sprintf("blob-entity-%d", time.Now().UTC().UnixNano())
	defer cleanupBlobValidationRows(context.Background(), pool, entityID, "")

	entityActions := entityactions.New(pool)
	publishedAt := time.Date(2026, 6, 10, 14, 30, 0, 0, time.UTC)

	created, err := entityActions.Create(ctx, entityactions.CreateParams{
		EntityID:    entityID,
		EntityType:  "asset",
		Subtype:     "drone",
		PublishedAt: &publishedAt,
		Components: map[string]interface{}{
			"telemetry": map[string]interface{}{
				"latitude":  40.7,
				"longitude": -73.9,
			},
		},
		Extra: map[string]interface{}{
			"mission_id": "mission-alpha",
		},
	})
	if err != nil {
		t.Fatalf("create entity: %v", err)
	}

	createdBlob := decodeRawJSON(t, created.JSON)
	if createdBlob["published_at"] != publishedAt.Format(time.RFC3339) {
		t.Fatalf("expected published_at in stored entity blob, got %v", createdBlob["published_at"])
	}
	requireNestedBlobString(t, createdBlob, "mission_id", "mission-alpha")
	requireNestedBlobNumber(t, createdBlob, []string{"components", "telemetry", "latitude"}, 40.7)

	updatedPublishedAt := "2026-06-10T15:00:00Z"
	updated, err := entityActions.Update(ctx, entityID, entityactions.UpdateParams{
		Components: map[string]interface{}{
			"heartbeat": map[string]interface{}{
				"last_seen": "2026-06-10T15:01:00Z",
			},
		},
		Extra: map[string]interface{}{
			"published_at": updatedPublishedAt,
			"mission_id":   "mission-beta",
		},
	})
	if err != nil {
		t.Fatalf("update entity: %v", err)
	}
	updatedBlob := decodeRawJSON(t, updated.JSON)
	if updatedBlob["published_at"] != updatedPublishedAt {
		t.Fatalf("expected updated published_at in entity blob, got %v", updatedBlob["published_at"])
	}
	requireNestedBlobString(t, updatedBlob, "mission_id", "mission-beta")
	requireNestedBlobString(t, updatedBlob, "components.heartbeat.last_seen", "2026-06-10T15:01:00Z")

	_, err = entityActions.Update(ctx, entityID, entityactions.UpdateParams{
		Extra: map[string]interface{}{
			"published_at": "not-rfc3339",
		},
	})
	var validationErr *actions.ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("expected final entity blob validation error, got %T %v", err, err)
	}
}

func TestTaskCreateAndUpdateValidateFinalStoredBlob(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	taskID := fmt.Sprintf("blob-task-%d", time.Now().UTC().UnixNano())
	defer cleanupBlobValidationRows(context.Background(), pool, "", taskID)

	taskActions := taskactions.New(pool)
	created, err := taskActions.Create(ctx, taskactions.CreateParams{
		TaskID: taskID,
		Status: "pending",
		Components: map[string]interface{}{
			"command": map[string]interface{}{
				"type": "move_to",
				"target": map[string]interface{}{
					"latitude":  40.7,
					"longitude": -73.9,
				},
			},
		},
		Extra: map[string]interface{}{
			"priority": "high",
		},
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	createdBlob := decodeRawJSON(t, created.JSON)
	requireNestedBlobString(t, createdBlob, "priority", "high")
	requireNestedBlobString(t, createdBlob, "components.command.type", "move_to")

	updated, err := taskActions.Update(ctx, taskID, taskactions.UpdateParams{
		Components: map[string]interface{}{
			"progress": map[string]interface{}{
				"percent":    25.0,
				"updated_at": "2026-06-10T15:02:00Z",
			},
		},
		Extra: map[string]interface{}{
			"operator_note": "payload kept",
		},
	})
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	updatedBlob := decodeRawJSON(t, updated.JSON)
	requireNestedBlobString(t, updatedBlob, "operator_note", "payload kept")
	requireNestedBlobNumber(t, updatedBlob, []string{"components", "progress", "percent"}, 25)

	_, err = taskActions.Update(ctx, taskID, taskactions.UpdateParams{
		Extra: map[string]interface{}{
			"bad_payload": math.Inf(1),
		},
	})
	var validationErr *actions.ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("expected final task blob validation error, got %T %v", err, err)
	}
}

func decodeRawJSON(t *testing.T, raw json.RawMessage) map[string]interface{} {
	t.Helper()
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("decode JSON blob: %v", err)
	}
	return data
}

func requireNestedBlobString(t *testing.T, data map[string]interface{}, path string, want string) {
	t.Helper()
	got := nestedBlobValue(t, data, path)
	if got != want {
		t.Fatalf("expected %s %q, got %v", path, want, got)
	}
}

func requireNestedBlobNumber(t *testing.T, data map[string]interface{}, path []string, want float64) {
	t.Helper()
	got := nestedBlobValueFromParts(t, data, path)
	number, ok := got.(float64)
	if !ok {
		t.Fatalf("expected %s to be a number, got %T", path, got)
	}
	if number != want {
		t.Fatalf("expected %s %v, got %v", path, want, number)
	}
}

func nestedBlobValue(t *testing.T, data map[string]interface{}, path string) interface{} {
	t.Helper()
	return nestedBlobValueFromParts(t, data, strings.Split(path, "."))
}

func nestedBlobValueFromParts(t *testing.T, data map[string]interface{}, path []string) interface{} {
	t.Helper()
	var current interface{} = data
	for _, part := range path {
		currentMap, ok := current.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map before %s, got %T", part, current)
		}
		current, ok = currentMap[part]
		if !ok {
			t.Fatalf("missing %s in blob", part)
		}
	}
	return current
}

func cleanupBlobValidationRows(ctx context.Context, pool *pgxpool.Pool, entityID, taskID string) {
	if taskID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID)
	}
	if entityID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM entities WHERE entity_id = $1`, entityID)
	}
}
