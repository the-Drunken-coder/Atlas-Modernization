package actions

import (
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func collectEntities(rows pgx.Rows) ([]*models.Entity, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Entity
	for rows.Next() {
		var e models.Entity
		if err := rows.Scan(&e.EntityID, &e.Type, &e.Subtype, &e.Alias, &e.JSON, &e.CreatedAt, &e.UpdatedAt, &e.Version); err != nil {
			return nil, fmt.Errorf("failed to scan entity: %w", err)
		}
		out = append(out, &e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating entity rows: %w", err)
	}
	return out, nil
}

func collectTasks(rows pgx.Rows) ([]*models.Task, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.Task
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.TaskID, &t.Status, &t.EntityID, &t.JSON, &t.CreatedAt, &t.UpdatedAt, &t.Version); err != nil {
			return nil, fmt.Errorf("failed to scan task: %w", err)
		}
		out = append(out, &t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating task rows: %w", err)
	}
	return out, nil
}

func collectObjects(rows pgx.Rows) ([]*models.MediaObject, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &o.Version); err != nil {
			return nil, fmt.Errorf("failed to scan object: %w", err)
		}
		out = append(out, &o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating object rows: %w", err)
	}
	return out, nil
}
