package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	atlasdb "github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestTaskLifecycleRoutesWithFixtureCommands(t *testing.T) {
	pool := openIsolatedFeedIntegrationPool(t)
	handler := NewHandler(&atlasdb.DB{Pool: pool}, nil, zerolog.Nop(), &config.Config{})
	handler.taskActions = actions.NewTaskActionsWithCatalog(pool, taskingHandlerFixture[protocol.CommandCatalog](t, "catalog.json"))

	assetID := "handler-tasking-" + time.Now().UTC().Format("20060102150405.000000000")
	if _, err := handler.entityActions.Create(t.Context(), actions.CreateEntityParams{EntityID: assetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create Asset: %v", err)
	}

	router := chi.NewRouter()
	router.Post("/tasks", handler.CreateTask)
	router.Post("/tasks/{task_id}/acknowledge", handler.AcknowledgeTask)
	router.Post("/tasks/{task_id}/start", handler.StartTask)
	router.Post("/tasks/{task_id}/progress", handler.ProgressTask)
	router.Post("/tasks/{task_id}/complete", handler.CompleteTask)
	router.Post("/tasks/{task_id}/fail", handler.FailTask)
	router.Post("/tasks/{task_id}/cancel", handler.CancelTask)
	router.Post("/entities/{entity_id}/runtime", handler.BeginAssetRuntime)
	router.Post("/entities/{entity_id}/runtime/ready", handler.ReadyAssetRuntime)
	router.Get("/entities/{entity_id}/runtime/tasks", handler.DeliverAssetTasks)
	router.Get("/entities/{entity_id}", handler.GetEntity)

	runtimeID := "runtime-1"
	requestTaskingRoute(t, router, http.MethodPost, "/entities/"+assetID+"/runtime", map[string]any{
		"runtime_id": runtimeID,
	}, nil, http.StatusNoContent, nil)
	requestTaskingRoute(t, router, http.MethodPost, "/entities/"+assetID+"/runtime/ready", map[string]any{
		"runtime_id": runtimeID,
		"manifest":   taskingHandlerFixture[protocol.CommandManifest](t, "manifest.json"),
	}, nil, http.StatusNoContent, nil)

	emptyManifestAssetID := assetID + "-empty"
	if _, err := handler.entityActions.Create(t.Context(), actions.CreateEntityParams{EntityID: emptyManifestAssetID, EntityType: "asset"}); err != nil {
		t.Fatalf("create empty-manifest Asset: %v", err)
	}
	requestTaskingRoute(t, router, http.MethodPost, "/entities/"+emptyManifestAssetID+"/runtime", map[string]any{
		"runtime_id": "runtime-empty",
	}, nil, http.StatusNoContent, nil)
	requestTaskingRoute(t, router, http.MethodPost, "/entities/"+emptyManifestAssetID+"/runtime/ready", map[string]any{
		"runtime_id": "runtime-empty",
		"manifest":   []any{},
	}, nil, http.StatusNoContent, nil)
	var emptyManifestDetail map[string]any
	requestTaskingRoute(t, router, http.MethodGet, "/entities/"+emptyManifestAssetID, nil, nil, http.StatusOK, &emptyManifestDetail)
	manifest, present := emptyManifestDetail["command_manifest"].([]any)
	if !present || len(manifest) != 0 {
		t.Fatalf("ready empty Command Manifest = %#v, want []", emptyManifestDetail["command_manifest"])
	}

	created := createTaskThroughHandler(t, router, assetID, "complete-attempt", "complete")
	var repeated protocol.TaskResource
	requestTaskingRoute(t, router, http.MethodPost, "/tasks", taskCreatePayload(assetID, "complete"), map[string]string{
		"Idempotency-Key": "complete-attempt",
	}, http.StatusOK, &repeated)
	if repeated.TaskID != created.TaskID {
		t.Fatalf("idempotent Task = %s, want %s", repeated.TaskID, created.TaskID)
	}

	var delivery protocol.RuntimeTaskDeliveryResponse
	requestTaskingRoute(t, router, http.MethodGet, "/entities/"+assetID+"/runtime/tasks", nil, map[string]string{
		"Atlas-Runtime-ID": runtimeID,
	}, http.StatusOK, &delivery)
	if len(delivery.Tasks) != 1 || delivery.Tasks[0].TaskID != created.TaskID {
		t.Fatalf("runtime delivery = %#v, want Task %s", delivery.Tasks, created.TaskID)
	}

	assertTaskRouteStatus(t, router, created.TaskID, "acknowledge", map[string]any{}, runtimeID, protocol.TaskStatusAcknowledged)
	assertTaskRouteStatus(t, router, created.TaskID, "start", map[string]any{}, runtimeID, protocol.TaskStatusInProgress)
	progressed := assertTaskRouteStatus(t, router, created.TaskID, "progress", map[string]any{"progress": 0.5}, runtimeID, protocol.TaskStatusInProgress)
	if progressed.Progress == nil || *progressed.Progress != 0.5 {
		t.Fatalf("Task progress = %#v, want 0.5", progressed.Progress)
	}
	failed := createTaskThroughHandler(t, router, assetID, "fail-attempt", "fail")
	assertTaskRouteStatus(t, router, failed.TaskID, "acknowledge", map[string]any{}, runtimeID, protocol.TaskStatusAcknowledged)
	requestTaskingRoute(t, router, http.MethodPost, "/tasks/"+failed.TaskID+"/start", map[string]any{}, map[string]string{
		"Atlas-Runtime-ID": runtimeID,
	}, http.StatusBadRequest, nil)
	completed := assertTaskRouteStatus(t, router, created.TaskID, "complete", map[string]any{
		"output": map[string]any{"result": "done"},
	}, runtimeID, protocol.TaskStatusCompleted)
	if completed.Output == nil {
		t.Fatal("completed Task omitted output")
	}
	assertTaskRouteStatus(t, router, failed.TaskID, "start", map[string]any{}, runtimeID, protocol.TaskStatusInProgress)
	failed = assertTaskRouteStatus(t, router, failed.TaskID, "fail", map[string]any{
		"failure": map[string]any{"code": "execution_failed", "message": "fixture failed"},
	}, runtimeID, protocol.TaskStatusFailed)
	if failed.Failure == nil || failed.Failure.Code != protocol.TaskFailureCodeExecutionFailed {
		t.Fatalf("Task failure = %#v", failed.Failure)
	}
	invalidOutput := createTaskThroughHandler(t, router, assetID, "invalid-output-attempt", "invalid-output")
	assertTaskRouteStatus(t, router, invalidOutput.TaskID, "acknowledge", map[string]any{}, runtimeID, protocol.TaskStatusAcknowledged)
	assertTaskRouteStatus(t, router, invalidOutput.TaskID, "start", map[string]any{}, runtimeID, protocol.TaskStatusInProgress)
	invalidOutput = assertTaskRouteStatus(t, router, invalidOutput.TaskID, "complete", map[string]any{
		"output": map[string]any{"result": ""},
	}, runtimeID, protocol.TaskStatusFailed)
	if invalidOutput.Failure == nil || invalidOutput.Failure.Code != protocol.TaskFailureCodeInvalidOutput {
		t.Fatalf("invalid output failure = %#v", invalidOutput.Failure)
	}

	cancelled := createTaskThroughHandler(t, router, assetID, "cancel-attempt", "cancel")
	cancelled = assertTaskRouteStatus(t, router, cancelled.TaskID, "cancel", map[string]any{
		"cancellation": map[string]any{"code": "requested", "message": "operator cancelled"},
	}, "", protocol.TaskStatusCancelled)
	if cancelled.Cancellation == nil || cancelled.Cancellation.Code != protocol.TaskCancellationCodeRequested {
		t.Fatalf("Task cancellation = %#v", cancelled.Cancellation)
	}

	immediateOne := createCommandTaskThroughHandler(t, router, assetID, "immediate-attempt-1", "fixture.immediate", map[string]any{})
	immediateTwo := createCommandTaskThroughHandler(t, router, assetID, "immediate-attempt-2", "fixture.immediate", map[string]any{})
	requestTaskingRoute(t, router, http.MethodGet, "/entities/"+assetID+"/runtime/tasks", nil, map[string]string{
		"Atlas-Runtime-ID": runtimeID,
	}, http.StatusOK, &delivery)
	if len(delivery.Tasks) != 1 || delivery.Tasks[0].TaskID != immediateOne.TaskID {
		t.Fatalf("initial immediate delivery = %#v, want Task %s", delivery.Tasks, immediateOne.TaskID)
	}
	assertTaskRouteStatus(t, router, immediateOne.TaskID, "start", map[string]any{}, runtimeID, protocol.TaskStatusInProgress)
	requestTaskingRoute(t, router, http.MethodGet, "/entities/"+assetID+"/runtime/tasks", nil, map[string]string{
		"Atlas-Runtime-ID": runtimeID,
	}, http.StatusOK, &delivery)
	if len(delivery.Tasks) != 1 || delivery.Tasks[0].TaskID != immediateTwo.TaskID {
		t.Fatalf("immediate delivery after first start = %#v, want Task %s", delivery.Tasks, immediateTwo.TaskID)
	}
}

func taskingHandlerFixture[T any](t *testing.T, name string) T {
	t.Helper()
	var data []byte
	var err error
	switch name {
	case "catalog.json":
		data, err = os.ReadFile("../../../../atlas_protocol/conformance/tasking/fixtures/catalog.json")
	case "manifest.json":
		data, err = os.ReadFile("../../../../atlas_protocol/conformance/tasking/fixtures/manifest.json")
	default:
		t.Fatalf("unknown tasking fixture %q", name)
	}
	if err != nil {
		t.Fatalf("read tasking fixture %s: %v", name, err)
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode tasking fixture %s: %v", name, err)
	}
	return value
}

func taskCreatePayload(assetID, value string) map[string]any {
	return map[string]any{
		"asset_id": assetID,
		"command":  "fixture.queued",
		"input":    map[string]any{"value": value},
	}
}

func createTaskThroughHandler(t *testing.T, router http.Handler, assetID, idempotencyKey, value string) protocol.TaskResource {
	t.Helper()
	return createCommandTaskThroughHandler(t, router, assetID, idempotencyKey, "fixture.queued", map[string]any{"value": value})
}

func createCommandTaskThroughHandler(t *testing.T, router http.Handler, assetID, idempotencyKey, command string, input any) protocol.TaskResource {
	t.Helper()
	var task protocol.TaskResource
	requestTaskingRoute(t, router, http.MethodPost, "/tasks", map[string]any{
		"asset_id": assetID,
		"command":  command,
		"input":    input,
	}, map[string]string{
		"Idempotency-Key": idempotencyKey,
	}, http.StatusCreated, &task)
	return task
}

func assertTaskRouteStatus(t *testing.T, router http.Handler, taskID, action string, payload map[string]any, runtimeID string, want protocol.TaskStatus) protocol.TaskResource {
	t.Helper()
	headers := map[string]string{}
	if runtimeID != "" {
		headers["Atlas-Runtime-ID"] = runtimeID
	}
	var task protocol.TaskResource
	requestTaskingRoute(t, router, http.MethodPost, "/tasks/"+taskID+"/"+action, payload, headers, http.StatusOK, &task)
	if task.Status != want {
		t.Fatalf("POST /tasks/%s/%s status = %s, want %s", taskID, action, task.Status, want)
	}
	return task
}

func requestTaskingRoute(t *testing.T, router http.Handler, method, path string, payload any, headers map[string]string, wantStatus int, result any) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal %s %s payload: %v", method, path, err)
		}
		body = bytes.NewReader(data)
	}
	request := httptest.NewRequest(method, path, body)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	response := recorder.Result()
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Errorf("close %s %s response: %v", method, path, err)
		}
	}()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("%s %s status = %d, want %d, body=%s", method, path, response.StatusCode, wantStatus, data)
	}
	if result == nil {
		return
	}
	if etag := response.Header.Get("ETag"); etag == "" && (path == "/tasks" || strings.HasPrefix(path, "/tasks/")) {
		t.Fatalf("%s %s omitted Task ETag", method, path)
	}
	if err := json.NewDecoder(response.Body).Decode(result); err != nil {
		t.Fatalf("decode %s %s response: %v", method, path, err)
	}
}
