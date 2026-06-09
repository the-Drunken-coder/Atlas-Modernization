package taskactions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// List retrieves tasks with pagination.
func (a *Actions) List(ctx context.Context, limit int, cursor string) (*actions.ListPage[*models.Task], error) {
	limit = actions.ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := actions.ParseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	tasks, hasMore, err := actions.QueryTasks(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit task list transaction: %w", err)
	}

	page := &actions.ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode task cursor: %w", err)
		}
	}
	return page, nil
}

// GetByEntity retrieves tasks for a specific entity.
func (a *Actions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*actions.ListPage[*models.Task], error) {
	if err := actions.ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = actions.SanitizeID(entityID)

	limit = actions.ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin entity task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read entity task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := actions.ParseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	tasks, hasMore, err := actions.QueryTasksByEntity(ctx, tx, entityID, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit entity task list transaction: %w", err)
	}

	page := &actions.ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.CreatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity task cursor: %w", err)
		}
	}
	return page, nil
}

// GetByEntityFiltered retrieves entity tasks filtered by status and updated-since timestamp.
func (a *Actions) GetByEntityFiltered(
	ctx context.Context,
	entityID string,
	statusList []string,
	since *time.Time,
	limit int,
	cursor string,
) (*actions.ListPage[*models.Task], error) {
	if err := actions.ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = actions.SanitizeID(entityID)

	limit, err := normalizeCheckinTaskLimit(limit)
	if err != nil {
		return nil, err
	}

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin filtered entity task list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read filtered entity task list snapshot timestamp: %w", err)
	}

	parsedCursor, err := actions.ParseQueryCursor(cursor, "task_cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, _, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}

	whereClauses := []string{"entity_id = $1"}
	args := []interface{}{entityID}

	normalizedStatuses := make([]string, 0, len(statusList))
	for _, status := range statusList {
		s := strings.ToLower(strings.TrimSpace(status))
		if s != "" {
			normalizedStatuses = append(normalizedStatuses, s)
		}
	}
	if len(normalizedStatuses) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("LOWER(status) = ANY($%d)", len(args)+1))
		args = append(args, normalizedStatuses)
	}

	if since != nil {
		whereClauses = append(whereClauses, fmt.Sprintf("updated_at >= $%d", len(args)+1))
		args = append(args, *since)
	}

	if parsedCursor != nil {
		cursorUpperBound := actions.EffectiveCursorUpperBound(parsedCursor, snapshotUpperBound)
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("updated_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(updated_at, task_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.Timestamp, parsedCursor.ID)
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
		return nil, fmt.Errorf("failed to list tasks: %w", err)
	}
	defer rows.Close()

	var tasks []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt, &t.Version); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		tasks = append(tasks, &t)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate tasks: %w", err)
	}

	tasks, hasMore := actions.TrimToLimitWithMore(tasks, limit)

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit filtered entity task list transaction: %w", err)
	}

	page := &actions.ListPage[*models.Task]{
		Items:   tasks,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(tasks) > 0 {
		last := tasks[len(tasks)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.UpdatedAt, last.TaskID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode filtered entity task cursor: %w", err)
		}
	}
	return page, nil
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
		return 0, actions.NewValidationError(fmt.Sprintf("limit must be between 1 and %d for check-in task pagination", maxLimit))
	}
	return limit, nil
}
