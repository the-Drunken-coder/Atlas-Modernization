package actions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestLiveActionsResourceLifecycleAndQueries(t *testing.T) {
	pool := openActionsLivePool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("actions-live-%d-", time.Now().UTC().UnixNano())
	var cleanupTaskIDs []string
	cleanupActionsLiveRows(ctx, t, pool, prefix)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupActionsLiveRows(cleanupCtx, t, pool, prefix, cleanupTaskIDs...)
	})

	baselineVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("CurrentChangeVersion baseline: %v", err)
	}

	entityActions := NewEntityActions(pool)
	taskActions := NewTaskActions(pool)
	storageClient := newMemoryObjectStorage("atlas-media")
	objectActions := NewObjectActions(pool, storageClient)
	queryActions := NewQueryActions(pool)

	entityID := prefix + "asset"
	secondEntityID := prefix + "asset-page"
	taskID := prefix + "task"
	objectID := prefix + "object"
	alias := prefix + "alias"
	updatedAlias := prefix + "updated-alias"
	entityType := "asset"

	entity, err := entityActions.Create(ctx, CreateEntityParams{
		EntityID:   entityID,
		EntityType: entityType,
		Alias:      &alias,
		Components: map[string]interface{}{
			"task_catalog": map[string]interface{}{"supported_tasks": []interface{}{"goto"}},
		},
		Extra: map[string]interface{}{"operator_note": "created by live action test"},
	})
	if err != nil {
		t.Fatalf("Create entity: %v", err)
	}
	if entity.EntityID != entityID || entity.Type != "asset" || entity.Alias == nil || *entity.Alias != alias {
		t.Fatalf("created entity = %#v", entity)
	}
	if _, err := entityActions.Create(ctx, CreateEntityParams{EntityID: secondEntityID, EntityType: "asset"}); err != nil {
		t.Fatalf("Create second entity: %v", err)
	}
	if byAlias, err := entityActions.GetByAlias(ctx, alias); err != nil || byAlias.EntityID != entityID {
		t.Fatalf("GetByAlias = %#v, %v; want %s", byAlias, err, entityID)
	}
	updatedEntity, err := entityActions.Update(ctx, entityID, UpdateEntityParams{
		Alias: &updatedAlias,
		Components: map[string]interface{}{
			"status": map[string]interface{}{"value": "ready", "last_update": "2026-06-20T00:00:00Z"},
		},
		ExpectedVersion: &entity.Version,
	})
	if err != nil {
		t.Fatalf("Update entity: %v", err)
	}
	if updatedEntity.Alias == nil || *updatedEntity.Alias != updatedAlias || updatedEntity.Version <= entity.Version {
		t.Fatalf("updated entity = %#v, want alias %q and newer version than %d", updatedEntity, updatedAlias, entity.Version)
	}

	task, err := taskActions.Create(ctx, CreateTaskParams{
		TaskID:   taskID,
		EntityID: &entityID,
		Extra:    map[string]interface{}{"priority": "high"},
	})
	if err != nil {
		t.Fatalf("Create task: %v", err)
	}
	acknowledgedStatus := "acknowledged"
	acknowledged, err := taskActions.Update(ctx, taskID, UpdateTaskParams{Status: &acknowledgedStatus, ExpectedVersion: &task.Version})
	if err != nil {
		t.Fatalf("Acknowledge task: %v", err)
	}
	completedStatus := "completed"
	completed, err := taskActions.Update(ctx, taskID, UpdateTaskParams{
		Status:          &completedStatus,
		Extra:           map[string]interface{}{"result": map[string]interface{}{"ok": true}},
		ExpectedVersion: &acknowledged.Version,
	})
	if err != nil {
		t.Fatalf("Complete task: %v", err)
	}
	if completed.Status != "completed" {
		t.Fatalf("completed task status = %q, want completed", completed.Status)
	}
	result, ok := completed.GetExtra()["result"].(map[string]interface{})
	if !ok || result["ok"] != true {
		t.Fatalf("completed task result = %#v, want ok=true", completed.GetExtra()["result"])
	}

	commandTask, err := taskActions.Create(ctx, CreateTaskParams{
		EntityID: &entityID,
		Components: map[string]interface{}{
			"command":    map[string]interface{}{"id": "goto"},
			"parameters": map[string]interface{}{"latitude": "38.5", "longitude": "-77.1", "arrival_radius": "4.25"},
		},
	})
	if err != nil {
		t.Fatalf("Create command task: %v", err)
	}
	cleanupTaskIDs = append(cleanupTaskIDs, commandTask.TaskID)
	if !strings.HasPrefix(commandTask.TaskID, "command-") || commandTask.Status != "pending" {
		t.Fatalf("command task = %#v, want generated pending command task", commandTask)
	}
	commandComponents := commandTask.GetComponents()
	parameters, ok := commandComponents["parameters"].(map[string]interface{})
	if !ok || fmt.Sprint(parameters["latitude"]) != "38.5" || fmt.Sprint(parameters["longitude"]) != "-77.1" || fmt.Sprint(parameters["arrival_radius"]) != "4.25" {
		t.Fatalf("command task parameters = %#v, want coerced numeric parameters", commandComponents["parameters"])
	}

	uploaded, err := objectActions.Upload(ctx, objectID, strings.NewReader("hello atlas"), int64(len("hello atlas")), "text/plain", "log", ptrString("scenario-output"))
	if err != nil {
		t.Fatalf("Upload object: %v", err)
	}
	if uploaded.Path == nil || !strings.HasPrefix(*uploaded.Path, "objects/"+objectID+"/") {
		t.Fatalf("uploaded object path = %#v", uploaded.Path)
	}
	referencedBy := []map[string]interface{}{{"entity_id": entityID}, {"task_id": taskID}}
	updatedObject, err := objectActions.Update(ctx, objectID, UpdateObjectParams{
		ReferencedBy:    referencedBy,
		Extra:           map[string]interface{}{"label": "live object"},
		ExpectedVersion: &uploaded.Version,
	})
	if err != nil {
		t.Fatalf("Update object references: %v", err)
	}
	if updatedObject.Version <= uploaded.Version {
		t.Fatalf("updated object version = %d, want > %d", updatedObject.Version, uploaded.Version)
	}
	reader, contentType, size, err := objectActions.Download(ctx, objectID)
	if err != nil {
		t.Fatalf("Download object: %v", err)
	}
	body, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil {
		t.Fatalf("read downloaded object: %v", readErr)
	}
	if closeErr != nil {
		t.Fatalf("close downloaded object: %v", closeErr)
	}
	if string(body) != "hello atlas" || contentType != "text/plain" || size != int64(len("hello atlas")) {
		t.Fatalf("download = body %q contentType %q size %d", string(body), contentType, size)
	}

	entityTasks, err := taskActions.GetByEntity(ctx, entityID, 10, "")
	if err != nil {
		t.Fatalf("GetByEntity tasks: %v", err)
	}
	if !taskPageContains(entityTasks, taskID) || !taskPageContains(entityTasks, commandTask.TaskID) {
		t.Fatalf("entity tasks = %#v, want %s and %s", entityTasks.Items, taskID, commandTask.TaskID)
	}
	entityObjects, err := objectActions.GetByEntity(ctx, entityID, 10, "")
	if err != nil {
		t.Fatalf("GetByEntity objects: %v", err)
	}
	if !objectPageContains(entityObjects, objectID) {
		t.Fatalf("entity objects = %#v, want %s", entityObjects.Items, objectID)
	}
	taskObjects, err := objectActions.GetByTask(ctx, taskID, 10, "")
	if err != nil {
		t.Fatalf("GetByTask objects: %v", err)
	}
	if !objectPageContains(taskObjects, objectID) {
		t.Fatalf("task objects = %#v, want %s", taskObjects.Items, objectID)
	}

	full, err := queryActions.GetFullDataset(ctx, &FullDatasetLimits{EntityLimit: 1, TaskLimit: 1, ObjectLimit: 1})
	if err != nil {
		t.Fatalf("GetFullDataset: %v", err)
	}
	if !full.HasMoreEntities || full.NextEntityCursor == "" {
		t.Fatalf("full dataset entity pagination = hasMore %v cursor %q, want next entity cursor", full.HasMoreEntities, full.NextEntityCursor)
	}
	nextFull, err := queryActions.GetFullDataset(ctx, &FullDatasetLimits{EntityLimit: 1, EntityCursor: &full.NextEntityCursor})
	if err != nil {
		t.Fatalf("GetFullDataset next entity page: %v", err)
	}
	if len(nextFull.Entities) == 0 {
		t.Fatal("next full dataset entity page was empty")
	}

	if err := taskActions.Delete(ctx, taskID); err != nil {
		t.Fatalf("Delete task: %v", err)
	}
	if err := taskActions.Delete(ctx, commandTask.TaskID); err != nil {
		t.Fatalf("Delete command task: %v", err)
	}
	if err := objectActions.Delete(ctx, objectID); err != nil {
		t.Fatalf("Delete object: %v", err)
	}
	if !storageClient.deletedPath(*uploaded.Path) {
		t.Fatalf("object delete did not delete uploaded path %q", *uploaded.Path)
	}
	if _, err := objectActions.Get(ctx, objectID); !isNotFound(err, ChangeResourceObject) {
		t.Fatalf("Get deleted object error = %v, want object not found", err)
	}
	if err := entityActions.Delete(ctx, entityID); err != nil {
		t.Fatalf("Delete entity: %v", err)
	}
	if _, err := entityActions.Get(ctx, entityID); !isNotFound(err, ChangeResourceEntity) {
		t.Fatalf("Get deleted entity error = %v, want entity not found", err)
	}

	changed, err := queryActions.GetDataChangedSince(ctx, baselineVersion, 50, nil)
	if err != nil {
		t.Fatalf("GetDataChangedSince: %v", err)
	}
	if !changeEventsContainDelete(changed.Events, ChangeResourceEntity, entityID) {
		t.Fatalf("changed events = %#v, want entity delete %s", changed.Events, entityID)
	}
	if !changeEventsContainDelete(changed.Events, ChangeResourceTask, taskID) {
		t.Fatalf("changed events = %#v, want task delete %s", changed.Events, taskID)
	}
	if !changeEventsContainDelete(changed.Events, ChangeResourceTask, commandTask.TaskID) {
		t.Fatalf("changed events = %#v, want task delete %s", changed.Events, commandTask.TaskID)
	}
	if !changeEventsContainDelete(changed.Events, ChangeResourceObject, objectID) {
		t.Fatalf("changed events = %#v, want object delete %s", changed.Events, objectID)
	}
	if changed.Version <= baselineVersion {
		t.Fatalf("changed-since version = %d, want > baseline %d", changed.Version, baselineVersion)
	}
}

func TestLiveEntityCheckinTaskReadFailureDoesNotMutate(t *testing.T) {
	pool := openActionsLivePool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("checkin-failure-%d-", time.Now().UTC().UnixNano())
	entityID := prefix + "asset"
	cleanupActionsLiveRows(ctx, t, pool, prefix)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupActionsLiveRows(cleanupCtx, t, pool, prefix)
	})

	created, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{
		EntityID:   entityID,
		EntityType: "asset",
		Components: map[string]interface{}{
			"status": map[string]interface{}{"value": "idle", "last_update": "2026-07-10T12:00:00Z"},
		},
	})
	if err != nil {
		t.Fatalf("create check-in entity: %v", err)
	}

	closedPool, err := pgxpool.New(ctx, pool.Config().ConnString())
	if err != nil {
		t.Fatalf("create closed task pool: %v", err)
	}
	closedPool.Close()

	checkins := NewEntityCheckinActions(
		NewEntityActions(pool),
		NewTaskActions(closedPool),
	)
	if _, err := checkins.CheckIn(ctx, EntityCheckinParams{EntityID: prefix + "missing", TaskLimit: 10}); err == nil {
		t.Fatal("CheckIn for missing entity succeeded")
	} else {
		var notFoundErr *NotFoundError
		if !errors.As(err, &notFoundErr) {
			t.Fatalf("CheckIn for missing entity error = %v, want NotFoundError before closed task pool is read", err)
		}
	}
	params := EntityCheckinParams{
		EntityID:        entityID,
		ExpectedVersion: &created.Version,
		TaskStatuses:    []string{"pending", "acknowledged"},
		TaskLimit:       10,
		Components: map[string]interface{}{
			"heartbeat": map[string]interface{}{"last_seen": "2026-07-10T12:01:00Z"},
			"telemetry": map[string]interface{}{"latitude": 38.8977, "longitude": -77.0365, "last_update": "2026-07-10T12:01:00Z"},
		},
	}
	staleVersion := created.Version - 1
	staleParams := params
	staleParams.ExpectedVersion = &staleVersion
	if _, err := checkins.CheckIn(ctx, staleParams); err == nil {
		t.Fatal("CheckIn with stale version succeeded")
	} else {
		var preconditionErr *PreconditionFailedError
		if !errors.As(err, &preconditionErr) {
			t.Fatalf("CheckIn with stale version error = %v, want PreconditionFailedError before closed task pool is read", err)
		}
	}

	beforeFailedVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version before failed check-in: %v", err)
	}
	if _, err := checkins.CheckIn(ctx, params); err == nil {
		t.Fatal("CheckIn with closed task pool succeeded, want task read failure")
	}
	unchanged, err := NewEntityActions(pool).Get(ctx, entityID)
	if err != nil {
		t.Fatalf("get entity after failed check-in: %v", err)
	}
	if unchanged.Version != created.Version || !bytes.Equal(unchanged.JSON, created.JSON) {
		t.Fatalf("failed check-in changed entity: before version/json=%d/%s after=%d/%s", created.Version, created.JSON, unchanged.Version, unchanged.JSON)
	}
	afterFailedVersion, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version after failed check-in: %v", err)
	}
	if afterFailedVersion != beforeFailedVersion {
		t.Fatalf("failed check-in advanced change version from %d to %d", beforeFailedVersion, afterFailedVersion)
	}

	retry := NewEntityCheckinActions(NewEntityActions(pool), NewTaskActions(pool))
	result, err := retry.CheckIn(ctx, params)
	if err != nil {
		t.Fatalf("retry check-in with original version: %v", err)
	}
	if result.Entity.Version <= created.Version {
		t.Fatalf("retry entity version = %d, want greater than %d", result.Entity.Version, created.Version)
	}
}

func TestUploadPreservesExistingTypeWhenOmitted(t *testing.T) {
	pool := openActionsLivePool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("actions-live-upload-type-%d", time.Now().UTC().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupActionsLiveRows(cleanupCtx, t, pool, objectID)
	})

	objectType := "observation"
	actions := NewObjectActions(pool, newMemoryObjectStorage("atlas-media"))
	if _, err := actions.Create(ctx, CreateObjectParams{ObjectID: objectID, Type: &objectType}); err != nil {
		t.Fatalf("create object metadata: %v", err)
	}

	uploaded, err := actions.Upload(ctx, objectID, strings.NewReader("content"), int64(len("content")), "text/plain", "", nil)
	if err != nil {
		t.Fatalf("upload object without type: %v", err)
	}
	if uploaded.Type == nil || *uploaded.Type != objectType {
		t.Fatalf("uploaded object type = %#v, want %q", uploaded.Type, objectType)
	}
}

func openActionsLivePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicitDBURL := actionsTestDatabaseURL()
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed action lifecycle tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		testenv.SkipOrFatal(t, "test database unavailable: %v", err)
	}
	if ok, err := actionsTestCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema is not present in test database")
	}
	return pool
}

func cleanupActionsLiveRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool, prefix string, taskIDs ...string) {
	t.Helper()
	pattern := prefix + "%"
	for _, taskID := range taskIDs {
		if _, err := pool.Exec(ctx, `DELETE FROM tasks WHERE task_id = $1`, taskID); err != nil {
			t.Fatalf("cleanup live action generated task %q: %v", taskID, err)
		}
	}
	statements := []string{
		`DELETE FROM storage_deletion_outbox WHERE object_id LIKE $1 OR path LIKE $1`,
		`DELETE FROM objects WHERE object_id LIKE $1`,
		`DELETE FROM tasks WHERE task_id LIKE $1`,
		`DELETE FROM entities WHERE entity_id LIKE $1`,
	}
	for _, stmt := range statements {
		if _, err := pool.Exec(ctx, stmt, pattern); err != nil {
			t.Fatalf("cleanup live action rows with %q using %q: %v", pattern, stmt, err)
		}
	}
}

func taskPageContains(page *ListPage[*models.Task], id string) bool {
	for _, item := range page.Items {
		if item.TaskID == id {
			return true
		}
	}
	return false
}

func objectPageContains(page *ListPage[*models.MediaObject], id string) bool {
	for _, item := range page.Items {
		if item.ObjectID == id {
			return true
		}
	}
	return false
}

func changeEventsContainDelete(items []protocol.FeedEvent, resourceType ChangeResource, id string) bool {
	for _, item := range items {
		if item.Event == ChangeEventDelete && item.ResourceType == resourceType && item.ID == id {
			return true
		}
	}
	return false
}

func isNotFound(err error, resourceType ChangeResource) bool {
	var notFound *NotFoundError
	return errors.As(err, &notFound) && notFound.ResourceType == resourceType
}

type memoryObjectStorage struct {
	bucket      string
	pathCounter atomic.Int64
	mu          sync.Mutex
	objects     map[string]memoryObject
	deleted     []string
}

type memoryObject struct {
	body        []byte
	contentType string
}

func newMemoryObjectStorage(bucket string) *memoryObjectStorage {
	return &memoryObjectStorage{bucket: bucket, objects: map[string]memoryObject{}}
}

func (s *memoryObjectStorage) Bucket() string {
	return s.bucket
}

func (s *memoryObjectStorage) NewObjectPath(objectID string) string {
	return nextVersionedObjectPath(&s.pathCounter, objectID)
}

func (s *memoryObjectStorage) UploadObjectFromReaderToPath(_ context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*storage.ObjectInfo, error) {
	body, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.objects[path] = memoryObject{body: append([]byte(nil), body...), contentType: contentType}
	s.mu.Unlock()
	return &storage.ObjectInfo{ObjectID: objectID, Bucket: s.bucket, Path: path, SizeBytes: size, ContentType: contentType}, nil
}

func (s *memoryObjectStorage) StreamObjectPath(_ context.Context, objectID, path string) (io.ReadCloser, *storage.ObjectInfo, error) {
	s.mu.Lock()
	object, ok := s.objects[path]
	s.mu.Unlock()
	if !ok {
		return nil, nil, &storage.ObjectNotFoundError{Bucket: s.bucket, ObjectName: path}
	}
	return io.NopCloser(bytes.NewReader(object.body)), &storage.ObjectInfo{
		ObjectID:    objectID,
		Bucket:      s.bucket,
		Path:        path,
		SizeBytes:   int64(len(object.body)),
		ContentType: object.contentType,
	}, nil
}

func (s *memoryObjectStorage) DeleteObjectPath(_ context.Context, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, path)
	s.deleted = append(s.deleted, path)
	return nil
}

func (s *memoryObjectStorage) deletedPath(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.deleted {
		if item == path {
			return true
		}
	}
	return false
}
