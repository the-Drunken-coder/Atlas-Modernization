package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// GetByEntity retrieves objects referenced by an entity.
func (a *ObjectActions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "entity_id", entityID, ValidateEntityID, limit, cursor)
}

// GetByTask retrieves objects referenced by a task.
func (a *ObjectActions) GetByTask(ctx context.Context, taskID string, limit int, cursor string) (*ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "task_id", taskID, ValidateTaskID, limit, cursor)
}

func (a *ObjectActions) getObjectsByJSONReference(
	ctx context.Context,
	refKey, id string,
	validate func(string) error,
	limit int,
	cursor string,
) (*ListPage[*models.MediaObject], error) {
	if err := validate(id); err != nil {
		return nil, err
	}
	id = SanitizeID(id)

	limit = ClampListLimit(limit)

	refData := []map[string]string{{refKey: id}}
	refJSONBytes, err := json.Marshal(refData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal reference JSON: %w", err)
	}
	refJSON := string(refJSONBytes)

	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.MediaObject]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "cursor",
		operation:   "object reference list",
		cursorName:  "object reference",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, _ bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.MediaObject, bool, error) {
			return queryObjectsByJSONReference(ctx, tx, refJSON, snapshotUpperBound, parsedCursor, limit)
		},
		rowCursor: func(object *models.MediaObject) (time.Time, string) {
			return object.CreatedAt, object.ObjectID
		},
	})
}

func queryObjectsByJSONReference(ctx context.Context, tx pgx.Tx, refJSON string, snapshotUpperBound time.Time, parsedCursor *parsedQueryCursor, limit int) ([]*models.MediaObject, bool, error) {
	whereClauses := []string{"json->'referenced_by' @> $1::jsonb"}
	args := []interface{}{refJSON}
	if parsedCursor != nil {
		cursorUpperBound := parsedCursor.upperBound
		if cursorUpperBound.IsZero() {
			cursorUpperBound = snapshotUpperBound
		}
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("created_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(created_at, object_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.timestamp, parsedCursor.id)
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("created_at <= $%d::timestamptz", len(args)+1))
		args = append(args, snapshotUpperBound)
	}

	limitPos := len(args) + 1
	args = append(args, limit+1)
	query := fmt.Sprintf(`
		SELECT object_id, path, content_type, type, json, created_at, updated_at, version
		FROM objects
		WHERE %s
		ORDER BY created_at DESC, object_id DESC
		LIMIT $%d
	`, strings.Join(whereClauses, " AND "), limitPos)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("failed to query objects: %w", err)
	}
	objects, err := collectObjects(rows)
	if err != nil {
		return nil, false, err
	}
	out, hasMore := trimToLimitWithMore(objects, limit)
	return out, hasMore, nil
}
