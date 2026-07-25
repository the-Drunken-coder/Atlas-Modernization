package actions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// GetByEntityFiltered retrieves entity tasks filtered by status and updated-since timestamp.
func (a *TaskActions) GetByEntityFiltered(
	ctx context.Context,
	entityID string,
	statusList []string,
	since *time.Time,
	limit int,
	cursor string,
) (*ListPage[*models.Task], error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	limit, err := normalizeCheckinTaskLimit(limit)
	if err != nil {
		return nil, err
	}

	normalizedStatuses := make([]string, 0, len(statusList))
	for _, status := range statusList {
		s := strings.ToLower(strings.TrimSpace(status))
		if s != "" {
			normalizedStatuses = append(normalizedStatuses, s)
		}
	}
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Task]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "task_cursor",
		operation:   "filtered entity task list",
		cursorName:  "filtered entity task",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, _ bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.Task, bool, error) {
			return queryTasksByEntityFiltered(ctx, tx, entityID, normalizedStatuses, since, snapshotUpperBound, parsedCursor, limit)
		},
		rowCursor: func(task *models.Task) (time.Time, string) {
			return task.UpdatedAt, task.TaskID
		},
	})
}

func queryTasksByEntityFiltered(
	ctx context.Context,
	tx pgx.Tx,
	entityID string,
	normalizedStatuses []string,
	since *time.Time,
	snapshotUpperBound time.Time,
	parsedCursor *parsedQueryCursor,
	limit int,
) ([]*models.Task, bool, error) {
	whereClauses := []string{"entity_id = $1"}
	args := []interface{}{entityID}

	if len(normalizedStatuses) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("LOWER(status) = ANY($%d)", len(args)+1))
		args = append(args, normalizedStatuses)
	}

	if since != nil {
		whereClauses = append(whereClauses, fmt.Sprintf("updated_at >= $%d", len(args)+1))
		args = append(args, *since)
	}

	if parsedCursor != nil {
		cursorUpperBound := effectiveCursorUpperBound(parsedCursor, snapshotUpperBound)
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("updated_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(updated_at, task_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.timestamp, parsedCursor.id)
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("updated_at <= $%d::timestamptz", len(args)+1))
		args = append(args, snapshotUpperBound)
	}

	limitPos := len(args) + 1
	args = append(args, limit+1)

	query := fmt.Sprintf(`
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks
		WHERE %s
		ORDER BY updated_at DESC, task_id DESC
		LIMIT $%d
	`, strings.Join(whereClauses, " AND "), limitPos)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("failed to list tasks: %w", err)
	}
	tasks, err := collectTasks(rows)
	if err != nil {
		return nil, false, err
	}
	out, hasMore := trimToLimitWithMore(tasks, limit)
	return out, hasMore, nil
}

func normalizeCheckinTaskLimit(limit int) (int, error) {
	const (
		defaultLimit = 10
		maxLimit     = 20
	)
	if limit == 0 {
		return defaultLimit, nil
	}
	if limit < 1 || limit > maxLimit {
		return 0, NewValidationError(fmt.Sprintf("limit must be between 1 and %d for check-in task pagination", maxLimit))
	}
	return limit, nil
}
