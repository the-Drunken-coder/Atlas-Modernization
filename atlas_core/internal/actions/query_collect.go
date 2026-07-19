package actions

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

type rowIterator interface {
	Close()
	Err() error
	Next() bool
}

func collectByteBoundedRows[T any](
	rows rowIterator,
	limit, maxBytes int,
	resource string,
	scan func() (T, int, error),
) ([]T, bool, error) {
	defer rows.Close()

	items := make([]T, 0, limit)
	retainedBytes := 0
	for rows.Next() {
		item, size, err := scan()
		if err != nil {
			return nil, false, fmt.Errorf("failed to scan %s: %w", resource, err)
		}
		if size > maxBytes {
			return nil, false, fmt.Errorf("stored %s response row is at least %d bytes, exceeding the %d-byte query page budget", resource, size, maxBytes)
		}
		if len(items) == limit || retainedBytes > maxBytes-size {
			return items, true, nil
		}
		items = append(items, item)
		retainedBytes += size
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("error iterating %s rows: %w", resource, err)
	}
	return items, false, nil
}

func collectByteBoundedEntities(rows pgx.Rows, limit, maxBytes int) ([]*models.Entity, bool, error) {
	return collectByteBoundedRows(rows, limit, maxBytes, "entity", func() (*models.Entity, int, error) {
		var entity models.Entity
		err := rows.Scan(
			&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
			&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
		)
		return &entity, entityRetainedBytes(&entity), err
	})
}

func collectByteBoundedTasks(rows pgx.Rows, limit, maxBytes int) ([]*models.Task, bool, error) {
	return collectByteBoundedRows(rows, limit, maxBytes, "task", func() (*models.Task, int, error) {
		var task models.Task
		err := rows.Scan(
			&task.TaskID, &task.Status, &task.EntityID, &task.JSON,
			&task.CreatedAt, &task.UpdatedAt, &task.Version,
		)
		return &task, taskRetainedBytes(&task), err
	})
}

func collectByteBoundedObjects(rows pgx.Rows, limit, maxBytes int) ([]*models.MediaObject, bool, error) {
	return collectByteBoundedRows(rows, limit, maxBytes, "object", func() (*models.MediaObject, int, error) {
		var object models.MediaObject
		err := rows.Scan(
			&object.ObjectID, &object.Path, &object.ContentType, &object.Type,
			&object.JSON, &object.CreatedAt, &object.UpdatedAt, &object.Version,
		)
		return &object, objectRetainedBytes(&object), err
	})
}

// The fixed allowance conservatively covers field names, quotes, separators,
// timestamps, version, and the enclosing object without serializing each row.
const serializedRowOverhead = 256

func entityRetainedBytes(entity *models.Entity) int {
	return serializedRowOverhead + jsonStringBytes(entity.EntityID) + jsonStringBytes(entity.Type) + jsonOptionalStringBytes(entity.Subtype) + jsonOptionalStringBytes(entity.Alias) + jsonValueBytes(entity.JSON)
}

func taskRetainedBytes(task *models.Task) int {
	return serializedRowOverhead + jsonStringBytes(task.TaskID) + jsonStringBytes(task.Status) + jsonOptionalStringBytes(task.EntityID) + jsonValueBytes(task.JSON)
}

func objectRetainedBytes(object *models.MediaObject) int {
	return serializedRowOverhead + jsonStringBytes(object.ObjectID) + jsonOptionalStringBytes(object.Path) + jsonOptionalStringBytes(object.ContentType) + jsonOptionalStringBytes(object.Type) + jsonValueBytes(object.JSON)
}

func jsonOptionalStringBytes(value *string) int {
	if value == nil {
		return 0
	}
	return jsonStringBytes(*value)
}

func jsonStringBytes(value string) int {
	return 6 * len(value)
}

// Stored JSON is already escaped. Go's encoder only expands HTML-sensitive
// ASCII bytes and the two Unicode line-separator runes when re-encoding it.
func jsonValueBytes(value []byte) int {
	size := len(value)
	for i := 0; i < len(value); i++ {
		switch value[i] {
		case '<', '>', '&':
			size += 5
		case 0xe2:
			if i+2 < len(value) && value[i+1] == 0x80 && (value[i+2] == 0xa8 || value[i+2] == 0xa9) {
				size += 3
				i += 2
			}
		}
	}
	return size
}

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
		var entityID *string
		if err := rows.Scan(&resourceID, &deletedAt, &version, &entityID); err != nil {
			return nil, fmt.Errorf("failed to scan deleted resource: %w", err)
		}
		out = append(out, DeletedResource{
			ID:        resourceID,
			Type:      resourceType,
			EntityID:  entityID,
			DeletedAt: deletedAt.UTC().Format(time.RFC3339Nano),
			Version:   version,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating deleted resource rows: %w", err)
	}
	return out, nil
}
