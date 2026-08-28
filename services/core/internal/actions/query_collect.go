package actions

import (
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
)

type rowIterator interface {
	Close()
	Err() error
	Next() bool
}

type rowScanner interface {
	Scan(dest ...any) error
}

type resourceQuerySpec[T any] struct {
	name          string
	queryName     string
	selectFrom    string
	idColumn      string
	scan          func(rowScanner) (T, error)
	retainedBytes func(T) int
}

var (
	entityResourceQuery = resourceQuerySpec[*models.Entity]{
		name: "entity", queryName: "entities", selectFrom: entitySelectSQL, idColumn: "entity_id",
		scan: scanEntity, retainedBytes: entityRetainedBytes,
	}
	taskResourceQuery = resourceQuerySpec[*models.Task]{
		name: "task", queryName: "tasks", selectFrom: taskSelectSQL, idColumn: "task_id",
		scan: scanTask, retainedBytes: taskRetainedBytes,
	}
	objectResourceQuery = resourceQuerySpec[*models.MediaObject]{
		name: "object", queryName: "objects", selectFrom: objectSelectSQL, idColumn: "object_id",
		scan: scanObject, retainedBytes: objectRetainedBytes,
	}
)

func scanEntity(row rowScanner) (*models.Entity, error) {
	var entity models.Entity
	err := row.Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	return &entity, err
}

func scanObject(row rowScanner) (*models.MediaObject, error) {
	var object models.MediaObject
	err := row.Scan(
		&object.ObjectID, &object.Path, &object.ContentType, &object.Type,
		&object.JSON, &object.CreatedAt, &object.UpdatedAt, &object.Version,
	)
	return &object, err
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

// The fixed allowance conservatively covers field names, quotes, separators,
// timestamps, version, and the enclosing object without serializing each row.
const serializedRowOverhead = 256

func entityRetainedBytes(entity *models.Entity) int {
	return serializedRowOverhead + jsonStringBytes(entity.EntityID) + jsonStringBytes(entity.Type) + jsonOptionalStringBytes(entity.Subtype) + jsonOptionalStringBytes(entity.Alias) + jsonValueBytes(entity.JSON)
}

func taskRetainedBytes(task *models.Task) int {
	return serializedRowOverhead + jsonStringBytes(task.TaskID) + jsonStringBytes(task.AssetID) + jsonStringBytes(task.Command) + jsonStringBytes(task.Status) +
		jsonValueBytes(task.Input) + jsonValueBytes(task.Output) + jsonValueBytes(task.Failure) + jsonValueBytes(task.Cancellation)
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

func collectRows[T any](rows pgx.Rows, spec resourceQuerySpec[T]) ([]T, error) {
	if rows == nil {
		return nil, nil
	}
	defer rows.Close()

	var out []T
	for rows.Next() {
		item, err := spec.scan(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan %s: %w", spec.name, err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating %s rows: %w", spec.name, err)
	}
	return out, nil
}
