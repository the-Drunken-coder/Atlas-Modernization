package objectactions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// List retrieves objects with pagination.
func (a *Actions) List(ctx context.Context, limit int, cursor string) (*actions.ListPage[*models.MediaObject], error) {
	limit = actions.ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin object list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read object list snapshot timestamp: %w", err)
	}

	parsedCursor, err := actions.ParseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	objects, hasMore, err := actions.QueryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit object list transaction: %w", err)
	}

	page := &actions.ListPage[*models.MediaObject]{
		Items:   objects,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(objects) > 0 {
		last := objects[len(objects)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
	}
	return page, nil
}

// GetByEntity retrieves objects referenced by an entity.
func (a *Actions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*actions.ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "entity_id", entityID, actions.ValidateEntityID, limit, cursor)
}

// GetByTask retrieves objects referenced by a task.
func (a *Actions) GetByTask(ctx context.Context, taskID string, limit int, cursor string) (*actions.ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "task_id", taskID, actions.ValidateTaskID, limit, cursor)
}

func (a *Actions) getObjectsByJSONReference(
	ctx context.Context,
	refKey, id string,
	validate func(string) error,
	limit int,
	cursor string,
) (*actions.ListPage[*models.MediaObject], error) {
	if err := validate(id); err != nil {
		return nil, err
	}
	id = actions.SanitizeID(id)

	limit = actions.ClampListLimit(limit)

	refData := []map[string]string{{refKey: id}}
	refJSONBytes, err := json.Marshal(refData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal reference JSON: %w", err)
	}
	refJSON := string(refJSONBytes)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin object reference list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read object reference list snapshot timestamp: %w", err)
	}

	parsedCursor, err := actions.ParseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, _, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}

	whereClauses := []string{"json->'referenced_by' @> $1::jsonb"}
	args := []interface{}{refJSON}
	if parsedCursor != nil {
		cursorUpperBound := parsedCursor.UpperBound
		if cursorUpperBound.IsZero() {
			cursorUpperBound = snapshotUpperBound
		}
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("created_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(created_at, object_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.Timestamp, parsedCursor.ID)
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
		return nil, fmt.Errorf("failed to query objects: %w", err)
	}
	defer rows.Close()

	var objects []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &o.Version); err != nil {
			return nil, fmt.Errorf("failed to scan object: %w", err)
		}
		objects = append(objects, &o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate objects: %w", err)
	}

	objects, hasMore := actions.TrimToLimitWithMore(objects, limit)

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit object reference list transaction: %w", err)
	}

	page := &actions.ListPage[*models.MediaObject]{
		Items:   objects,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(objects) > 0 {
		last := objects[len(objects)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object reference cursor: %w", err)
		}
	}
	return page, nil
}
