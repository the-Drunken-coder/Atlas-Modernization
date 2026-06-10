package syncactions

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func collectVersionEntities(rows pgx.Rows) ([]*models.Entity, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Entity
	for rows.Next() {
		var entity models.Entity
		if err := rows.Scan(&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias, &entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version); err != nil {
			return nil, fmt.Errorf("failed to scan entity: %w", err)
		}
		out = append(out, &entity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating entity rows: %w", err)
	}
	return out, nil
}

func collectVersionTasks(rows pgx.Rows) ([]*models.Task, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Task
	for rows.Next() {
		var task models.Task
		if err := rows.Scan(&task.TaskID, &task.Status, &task.EntityID, &task.JSON, &task.CreatedAt, &task.UpdatedAt, &task.Version); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		out = append(out, &task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating task rows: %w", err)
	}
	return out, nil
}

func collectVersionObjects(rows pgx.Rows) ([]*models.MediaObject, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.MediaObject
	for rows.Next() {
		var obj models.MediaObject
		if err := rows.Scan(&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type, &obj.JSON, &obj.CreatedAt, &obj.UpdatedAt, &obj.Version); err != nil {
			return nil, fmt.Errorf("failed to scan object: %w", err)
		}
		out = append(out, &obj)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating object rows: %w", err)
	}
	return out, nil
}

func collectDeletedResources(rows pgx.Rows, resourceType string) ([]DeletedResource, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []DeletedResource
	for rows.Next() {
		var resourceID string
		var deletedAt time.Time
		var version int64
		if err := rows.Scan(&resourceID, &deletedAt, &version); err != nil {
			return nil, err
		}
		out = append(out, DeletedResource{
			ID:        resourceID,
			Type:      resourceType,
			DeletedAt: deletedAt.UTC().Format(time.RFC3339Nano),
			Version:   version,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
