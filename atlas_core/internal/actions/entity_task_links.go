package actions

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func queryTasksByEntityForUpdate(ctx context.Context, tx pgx.Tx, entityID string) ([]*models.Task, error) {
	rows, err := tx.Query(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks WHERE entity_id = $1
		ORDER BY task_id
		FOR UPDATE
	`, entityID)
	if err != nil {
		return nil, fmt.Errorf("failed to lock entity tasks before deletion: %w", err)
	}
	defer rows.Close()
	return scanTaskRows(rows)
}

func queryTasksByIDs(ctx context.Context, tx pgx.Tx, ids []string) (map[string]*models.Task, error) {
	tasks := make(map[string]*models.Task, len(ids))
	if len(ids) == 0 {
		return tasks, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT task_id, status, entity_id, json, created_at, updated_at, version
		FROM tasks WHERE task_id = ANY($1)
	`, ids)
	if err != nil {
		return nil, fmt.Errorf("failed to load entity tasks after deletion: %w", err)
	}
	defer rows.Close()
	list, err := scanTaskRows(rows)
	if err != nil {
		return nil, err
	}
	for _, task := range list {
		tasks[task.TaskID] = task
	}
	return tasks, nil
}

func taskIDs(tasks []*models.Task) []string {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.TaskID)
	}
	return ids
}

func scanTaskRows(rows pgx.Rows) ([]*models.Task, error) {
	var tasks []*models.Task
	for rows.Next() {
		var task models.Task
		if err := rows.Scan(&task.TaskID, &task.Status, &task.EntityID, &task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		tasks = append(tasks, &task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate tasks: %w", err)
	}
	return tasks, nil
}
