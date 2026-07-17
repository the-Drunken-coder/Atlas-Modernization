package actions

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestParseChangedSinceCursorsPreservesIndependentStreams(t *testing.T) {
	makeCursor := func(version int64, id string) string {
		cursor, err := encodeVersionCursor(version, id, 100, 7)
		if err != nil {
			t.Fatalf("encode %s cursor: %v", id, err)
		}
		return cursor
	}
	entityCursor := makeCursor(42, "entity-row")
	taskCursor := makeCursor(43, "task-row")
	objectCursor := makeCursor(44, "object-row")
	deletedEntityCursor := makeCursor(45, "deleted-entity-row")
	deletedTaskCursor := makeCursor(46, "deleted-task-row")
	deletedObjectCursor := makeCursor(47, "deleted-object-row")
	cursors := &ChangedSinceCursors{
		EntityCursor:        &entityCursor,
		TaskCursor:          &taskCursor,
		ObjectCursor:        &objectCursor,
		DeletedEntityCursor: &deletedEntityCursor,
		DeletedTaskCursor:   &deletedTaskCursor,
		DeletedObjectCursor: &deletedObjectCursor,
	}

	parsed, err := parseChangedSinceCursors(cursors)
	if err != nil {
		t.Fatalf("parse changed-since cursors: %v", err)
	}
	if upper, continuation, err := parsed.snapshot(7, 100); err != nil || upper != 100 || !continuation {
		t.Fatalf("snapshot = (%d, %v, %v), want (100, true, nil)", upper, continuation, err)
	}
	for _, test := range []struct {
		name    string
		cursor  *parsedVersionCursor
		id      string
		version int64
	}{
		{name: "entity", cursor: parsed.entity, id: "entity-row", version: 42},
		{name: "task", cursor: parsed.task, id: "task-row", version: 43},
		{name: "object", cursor: parsed.object, id: "object-row", version: 44},
		{name: "deleted entity", cursor: parsed.deletedEntity, id: "deleted-entity-row", version: 45},
		{name: "deleted task", cursor: parsed.deletedTask, id: "deleted-task-row", version: 46},
		{name: "deleted object", cursor: parsed.deletedObject, id: "deleted-object-row", version: 47},
	} {
		if test.cursor == nil || test.cursor.version != test.version || test.cursor.id != test.id || test.cursor.upperBound != 100 || test.cursor.sinceVersion != 7 {
			t.Errorf("%s cursor = %#v, want id %q version %d snapshot 100 since_version 7", test.name, test.cursor, test.id, test.version)
		}
	}
}

func TestParseChangedSinceCursorsHandlesAbsentMalformedAndStaleInputs(t *testing.T) {
	parsed, err := parseChangedSinceCursors(nil)
	if err != nil {
		t.Fatalf("parse absent cursors: %v", err)
	}
	if _, continuation, err := parsed.snapshot(0, 50); err != nil || continuation {
		t.Fatalf("absent cursor snapshot = (%v, %v), want no continuation", continuation, err)
	}

	malformed := "not-base64"
	_, err = parseChangedSinceCursors(&ChangedSinceCursors{EntityCursor: &malformed})
	validationErr, ok := err.(*ValidationError)
	if !ok || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "entity_cursor") {
		t.Fatalf("malformed cursor error = %v, want entity_cursor validation detail", err)
	}

	valid, err := encodeVersionCursor(42, "row", 30, 7)
	if err != nil {
		t.Fatalf("encode stale cursor: %v", err)
	}
	parsed, err = parseChangedSinceCursors(&ChangedSinceCursors{EntityCursor: &valid})
	if err != nil {
		t.Fatalf("parse stale cursor: %v", err)
	}
	if upper, continuation, err := parsed.snapshot(7, 50); err != nil || upper != 30 || !continuation {
		t.Fatalf("stale snapshot = (%d, %v, %v), want (30, true, nil)", upper, continuation, err)
	}
	_, _, err = parsed.snapshot(8, 50)
	validationErr, ok = err.(*ValidationError)
	if !ok || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "since_version") {
		t.Fatalf("since-version mismatch error = %v, want validation error", err)
	}
}

func TestGetDataChangedSincePreservesBeginDatabaseError(t *testing.T) {
	pool := openActionsTestPool(t)
	pool.Close()

	_, err := NewQueryActions(pool).GetDataChangedSince(context.Background(), 0, 1, nil)
	if err == nil || !strings.Contains(err.Error(), "begin transaction") {
		t.Fatalf("closed-pool error = %v, want begin transaction contract", err)
	}
}

func TestGetDataChangedSincePaginatesEveryStreamWithoutGaps(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("cs-%d-", time.Now().UTC().UnixNano())
	entityIDs := []string{prefix + "entity-1", prefix + "entity-2"}
	taskIDs := []string{prefix + "task-1", prefix + "task-2"}
	objectIDs := []string{prefix + "object-1", prefix + "object-2"}
	deletedEntityIDs := []string{prefix + "deleted-entity-1", prefix + "deleted-entity-2"}
	deletedTaskIDs := []string{prefix + "deleted-task-1", prefix + "deleted-task-2"}
	deletedObjectIDs := []string{prefix + "deleted-object-1", prefix + "deleted-object-2"}
	cleanupIDs := append(append(append(append(append(append([]string{}, entityIDs...), taskIDs...), objectIDs...), deletedEntityIDs...), deletedTaskIDs...), deletedObjectIDs...)
	for _, id := range cleanupIDs {
		if len(id) > IDMaxLength {
			t.Fatalf("changed-since fixture ID %q has length %d, want <= %d", id, len(id), IDMaxLength)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM deletions WHERE resource_id = ANY($1)`, cleanupIDs); err != nil {
			t.Errorf("cleanup changed-since tombstones: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM tasks WHERE task_id = ANY($1)`, taskIDs); err != nil {
			t.Errorf("cleanup changed-since tasks: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM objects WHERE object_id = ANY($1)`, objectIDs); err != nil {
			t.Errorf("cleanup changed-since objects: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, entityIDs); err != nil {
			t.Errorf("cleanup changed-since entities: %v", err)
		}
	})

	baseline, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read changed-since baseline: %v", err)
	}
	insertVersionedRows := func(query string, args ...any) {
		var version int64
		if err := pool.QueryRow(ctx, query, args...).Scan(&version); err != nil {
			t.Fatalf("insert changed-since fixture: %v", err)
		}
		if version <= baseline {
			t.Fatalf("fixture version = %d, want greater than baseline %d", version, baseline)
		}
	}
	for _, id := range entityIDs {
		insertVersionedRows(`INSERT INTO entities (entity_id, type, json) VALUES ($1, 'asset', '{}'::jsonb) RETURNING version`, id)
	}
	for i, id := range taskIDs {
		insertVersionedRows(`INSERT INTO tasks (task_id, status, entity_id, json) VALUES ($1, 'pending', $2, '{}'::jsonb) RETURNING version`, id, entityIDs[i])
	}
	for _, id := range objectIDs {
		insertVersionedRows(`INSERT INTO objects (object_id, json) VALUES ($1, '{}'::jsonb) RETURNING version`, id)
	}
	for _, id := range deletedEntityIDs {
		insertVersionedRows(`INSERT INTO deletions (resource_type, resource_id, context) VALUES ('entity', $1, '{}'::jsonb) RETURNING version`, id)
	}
	for i, id := range deletedTaskIDs {
		insertVersionedRows(`INSERT INTO deletions (resource_type, resource_id, context) VALUES ('task', $1, jsonb_build_object('entity_id', $2::text)) RETURNING version`, id, entityIDs[i])
	}
	for _, id := range deletedObjectIDs {
		insertVersionedRows(`INSERT INTO deletions (resource_type, resource_id, context) VALUES ('object', $1, '{}'::jsonb) RETURNING version`, id)
	}

	queryActions := NewQueryActions(pool)
	firstPage, err := queryActions.GetDataChangedSince(ctx, baseline, 1, nil)
	if err != nil {
		t.Fatalf("changed-since first page: %v", err)
	}
	if firstPage.Version <= baseline {
		t.Fatalf("first page version = %d, want greater than baseline %d", firstPage.Version, baseline)
	}

	type streamCase struct {
		name       string
		want       []string
		ids        func(*ChangedSinceResult) []string
		hasMore    func(*ChangedSinceResult) bool
		nextCursor func(*ChangedSinceResult) string
		setCursor  func(*ChangedSinceCursors, *string)
	}
	streams := []streamCase{
		{
			name: "entities", want: []string{entityIDs[1], entityIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return entityResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreEntities },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextEntityCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.EntityCursor = cursor },
		},
		{
			name: "tasks", want: []string{taskIDs[1], taskIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return taskResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreTasks },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextTaskCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.TaskCursor = cursor },
		},
		{
			name: "objects", want: []string{objectIDs[1], objectIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return objectResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreObjects },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextObjectCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.ObjectCursor = cursor },
		},
		{
			name: "deleted entities", want: []string{deletedEntityIDs[1], deletedEntityIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return deletedEntityResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreDeletedEntities },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextDeletedEntityCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.DeletedEntityCursor = cursor },
		},
		{
			name: "deleted tasks", want: []string{deletedTaskIDs[1], deletedTaskIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return deletedTaskResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreDeletedTasks },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextDeletedTaskCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.DeletedTaskCursor = cursor },
		},
		{
			name: "deleted objects", want: []string{deletedObjectIDs[1], deletedObjectIDs[0]},
			ids:        func(result *ChangedSinceResult) []string { return deletedObjectResultIDs(result) },
			hasMore:    func(result *ChangedSinceResult) bool { return result.HasMoreDeletedObjects },
			nextCursor: func(result *ChangedSinceResult) string { return result.NextDeletedObjectCursor },
			setCursor:  func(cursors *ChangedSinceCursors, cursor *string) { cursors.DeletedObjectCursor = cursor },
		},
	}

	for _, stream := range streams {
		firstIDs := stream.ids(firstPage)
		if len(firstIDs) != 1 || firstIDs[0] != stream.want[0] || !stream.hasMore(firstPage) {
			t.Fatalf("%s first page = %#v hasMore=%v, want [%q] and true", stream.name, firstIDs, stream.hasMore(firstPage), stream.want[0])
		}
		cursor := stream.nextCursor(firstPage)
		if cursor == "" {
			t.Fatalf("%s first page has no continuation cursor", stream.name)
		}
		_, cursorID, cursorSnapshot, cursorSince, err := decodeVersionCursor(cursor)
		if err != nil || cursorID != stream.want[0] || cursorSnapshot != firstPage.Version || cursorSince != baseline {
			t.Fatalf("%s cursor = (%q, %d, %d), err=%v; want last row %q snapshot %d since %d", stream.name, cursorID, cursorSnapshot, cursorSince, err, stream.want[0], firstPage.Version, baseline)
		}

		continuation := &ChangedSinceCursors{}
		stream.setCursor(continuation, &cursor)
		secondPage, err := queryActions.GetDataChangedSince(ctx, baseline, 1, continuation)
		if err != nil {
			t.Fatalf("%s continuation: %v", stream.name, err)
		}
		secondIDs := stream.ids(secondPage)
		if len(secondIDs) != 1 || secondIDs[0] != stream.want[1] || stream.hasMore(secondPage) || stream.nextCursor(secondPage) != "" {
			t.Fatalf("%s continuation = %#v hasMore=%v cursor=%q, want [%q], false, empty", stream.name, secondIDs, stream.hasMore(secondPage), stream.nextCursor(secondPage), stream.want[1])
		}
		if secondPage.Version != firstPage.Version {
			t.Fatalf("%s continuation version = %d, want first-page snapshot %d", stream.name, secondPage.Version, firstPage.Version)
		}
		for _, other := range streams {
			if other.name != stream.name && len(other.ids(secondPage)) != 0 {
				t.Fatalf("%s continuation unexpectedly returned %s rows: %#v", stream.name, other.name, other.ids(secondPage))
			}
		}
	}

	mixed := &ChangedSinceCursors{}
	entityCursor := streams[0].nextCursor(firstPage)
	deletedTaskCursor := streams[4].nextCursor(firstPage)
	streams[0].setCursor(mixed, &entityCursor)
	streams[4].setCursor(mixed, &deletedTaskCursor)
	mixedPage, err := queryActions.GetDataChangedSince(ctx, baseline, 1, mixed)
	if err != nil {
		t.Fatalf("mixed continuation: %v", err)
	}
	if got := entityResultIDs(mixedPage); len(got) != 1 || got[0] != entityIDs[0] {
		t.Fatalf("mixed entity continuation = %#v, want [%q]", got, entityIDs[0])
	}
	if got := deletedTaskResultIDs(mixedPage); len(got) != 1 || got[0] != deletedTaskIDs[0] {
		t.Fatalf("mixed deleted-task continuation = %#v, want [%q]", got, deletedTaskIDs[0])
	}
	for _, stream := range streams {
		if stream.name != "entities" && stream.name != "deleted tasks" && len(stream.ids(mixedPage)) != 0 {
			t.Fatalf("mixed continuation unexpectedly returned %s rows: %#v", stream.name, stream.ids(mixedPage))
		}
	}
	if mixedPage.Version != firstPage.Version {
		t.Fatalf("mixed continuation version = %d, want first-page snapshot %d", mixedPage.Version, firstPage.Version)
	}

	emptySince, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read empty changed-since version: %v", err)
	}
	emptyPage, err := queryActions.GetDataChangedSince(ctx, emptySince, 1, nil)
	if err != nil {
		t.Fatalf("empty changed-since page: %v", err)
	}
	for _, stream := range streams {
		if len(stream.ids(emptyPage)) != 0 || stream.hasMore(emptyPage) || stream.nextCursor(emptyPage) != "" {
			t.Fatalf("empty %s stream = %#v hasMore=%v cursor=%q, want empty and exhausted", stream.name, stream.ids(emptyPage), stream.hasMore(emptyPage), stream.nextCursor(emptyPage))
		}
	}
}

func entityResultIDs(result *ChangedSinceResult) []string {
	ids := make([]string, 0, len(result.Entities))
	for _, entity := range result.Entities {
		ids = append(ids, entity.EntityID)
	}
	return ids
}

func taskResultIDs(result *ChangedSinceResult) []string {
	ids := make([]string, 0, len(result.Tasks))
	for _, task := range result.Tasks {
		ids = append(ids, task.TaskID)
	}
	return ids
}

func objectResultIDs(result *ChangedSinceResult) []string {
	ids := make([]string, 0, len(result.Objects))
	for _, object := range result.Objects {
		ids = append(ids, object.ObjectID)
	}
	return ids
}

func deletedEntityResultIDs(result *ChangedSinceResult) []string {
	return deletedResultIDs(result.DeletedEntities)
}

func deletedTaskResultIDs(result *ChangedSinceResult) []string {
	return deletedResultIDs(result.DeletedTasks)
}

func deletedObjectResultIDs(result *ChangedSinceResult) []string {
	return deletedResultIDs(result.DeletedObjects)
}

func deletedResultIDs(resources []DeletedResource) []string {
	ids := make([]string, 0, len(resources))
	for _, resource := range resources {
		ids = append(ids, resource.ID)
	}
	return ids
}

func TestTrimToLimitWithMoreChangedSinceBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		items   []string
		limit   int
		want    []string
		hasMore bool
	}{
		{name: "exact page", items: []string{"a", "b"}, limit: 2, want: []string{"a", "b"}},
		{name: "one over page", items: []string{"a", "b", "c"}, limit: 2, want: []string{"a", "b"}, hasMore: true},
		{name: "empty page", items: nil, limit: 2, want: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, hasMore := trimToLimitWithMore(test.items, test.limit)
			if len(got) != len(test.want) || hasMore != test.hasMore {
				t.Fatalf("page = %#v, hasMore=%v; want %#v, %v", got, hasMore, test.want, test.hasMore)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("page[%d] = %q, want %q", i, got[i], test.want[i])
				}
			}
		})
	}
}

func TestAssembleChangedSinceResultKeepsIndependentContinuationAndSnapshot(t *testing.T) {
	page := &changedSincePage{
		entities: []*models.Entity{
			{EntityID: "entity-first", Version: 11},
			{EntityID: "entity-last", Version: 10},
		},
		tasks:                  []*models.Task{{TaskID: "task-only", Version: 9}},
		deletedEntities:        []DeletedResource{{ID: "deleted-entity", Type: "entity", Version: 8}},
		deletedTasks:           []DeletedResource{{ID: "deleted-task", Type: "task", Version: 7}},
		deletedObjects:         []DeletedResource{{ID: "deleted-object", Type: "object", Version: 6}},
		hasMoreEntities:        true,
		hasMoreDeletedEntities: true,
		hasMoreDeletedTasks:    true,
		hasMoreDeletedObjects:  true,
	}
	timestamp := time.Date(2026, 7, 17, 20, 0, 0, 123456789, time.UTC)

	result, err := assembleChangedSinceResult(page, timestamp, 100, 7)
	if err != nil {
		t.Fatalf("assemble result: %v", err)
	}
	if result.Version != 100 || result.Timestamp != timestamp.Format(time.RFC3339Nano) {
		t.Fatalf("snapshot metadata = (%d, %q), want (100, %q)", result.Version, result.Timestamp, timestamp.Format(time.RFC3339Nano))
	}
	if !result.HasMoreEntities || result.HasMoreTasks || !result.HasMoreDeletedEntities || !result.HasMoreDeletedTasks || !result.HasMoreDeletedObjects {
		t.Fatalf("continuation flags = %#v, want only entity and tombstone streams with more rows", result)
	}
	if result.NextTaskCursor != "" || result.NextObjectCursor != "" {
		t.Fatalf("uncontinued cursors = task %q object %q, want empty", result.NextTaskCursor, result.NextObjectCursor)
	}

	for name, cursor := range map[string]string{
		"entity":         result.NextEntityCursor,
		"deleted entity": result.NextDeletedEntityCursor,
		"deleted task":   result.NextDeletedTaskCursor,
		"deleted object": result.NextDeletedObjectCursor,
	} {
		version, id, upper, since, err := decodeVersionCursor(cursor)
		if err != nil {
			t.Fatalf("decode %s cursor: %v", name, err)
		}
		if upper != 100 || since != 7 {
			t.Errorf("%s cursor snapshot = (%d, %d), want (100, 7)", name, upper, since)
		}
		wantID, wantVersion := map[string]struct {
			id      string
			version int64
		}{
			"entity":         {id: "entity-last", version: 10},
			"deleted entity": {id: "deleted-entity", version: 8},
			"deleted task":   {id: "deleted-task", version: 7},
			"deleted object": {id: "deleted-object", version: 6},
		}[name].id, map[string]int64{
			"entity":         10,
			"deleted entity": 8,
			"deleted task":   7,
			"deleted object": 6,
		}[name]
		if id != wantID || version != wantVersion {
			t.Errorf("%s cursor = (%d, %q), want (%d, %q)", name, version, id, wantVersion, wantID)
		}
	}
}

func TestAssembleChangedSinceResultPreservesCursorErrorContracts(t *testing.T) {
	_, err := assembleChangedSinceResult(&changedSincePage{
		entities:        []*models.Entity{{EntityID: "missing-version"}},
		hasMoreEntities: true,
	}, time.Time{}, 100, 7)
	if err == nil || !strings.Contains(err.Error(), "encode entity cursor") {
		t.Fatalf("entity cursor error = %v, want encode entity cursor contract", err)
	}

	_, err = assembleChangedSinceResult(&changedSincePage{
		deletedObjects:        []DeletedResource{{ID: "missing-version", Type: "object"}},
		hasMoreDeletedObjects: true,
	}, time.Time{}, 100, 7)
	if err == nil || !strings.Contains(err.Error(), "next_deleted_object_cursor") {
		t.Fatalf("deleted cursor error = %v, want next_deleted_object_cursor contract", err)
	}
}
