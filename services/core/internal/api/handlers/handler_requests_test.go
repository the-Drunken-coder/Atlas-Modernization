package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/packages/protocol/conformance"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
)

func TestCreateEntityRejectsInvalidJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
	if body["path"] != "/entities" {
		t.Fatalf("expected error path /entities, got %v", body["path"])
	}
}

func TestDecodeProtocolRequestBodyAllowsEmptyCheckInBody(t *testing.T) {
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/entities/entity-1/checkin", nil)
	var decoded protocol.EntityCheckInRequest

	if !handler.decodeProtocolRequestBody(
		recorder,
		request,
		&decoded,
		true,
		protocol.ValidateEntityCheckInRequest,
	) {
		t.Fatalf("empty check-in body rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestTaskingHandlersRejectOversizedBodies(t *testing.T) {
	body := `{"payload":"` + strings.Repeat("x", maxTaskingRequestBodyBytes) + `"}`
	tests := map[string]func(*Handler, http.ResponseWriter, *http.Request){
		"create":      (*Handler).CreateTask,
		"acknowledge": (*Handler).AcknowledgeTask,
		"start":       (*Handler).StartTask,
		"progress":    (*Handler).ProgressTask,
		"complete":    (*Handler).CompleteTask,
		"fail":        (*Handler).FailTask,
		"cancel":      (*Handler).CancelTask,
		"runtime":     (*Handler).BeginAssetRuntime,
		"ready":       (*Handler).ReadyAssetRuntime,
	}
	for name, handle := range tests {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/tasking", strings.NewReader(body))

			handle(newTestHandler(), recorder, request)

			if recorder.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
			}
			if response := decodeBody(t, recorder); response["error_code"] != string(protocol.ErrorCodeBodyTooLarge) {
				t.Fatalf("error_code = %v, want %s", response["error_code"], protocol.ErrorCodeBodyTooLarge)
			}
		})
	}
}

func TestCompleteTaskRequestPreservesExplicitNull(t *testing.T) {
	handler := newTestHandler()
	for name, body := range map[string]string{"omitted": `{}`, "null": `{"output":null}`} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/tasks/task-1/complete", strings.NewReader(body))
			var decoded completeTaskRequest

			if !handler.decodeProtocolRequestBody(recorder, request, &decoded, false, protocol.ValidateTaskCompleteRequest) {
				t.Fatalf("request rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if name == "omitted" && decoded.Output != nil {
				t.Fatalf("omitted output = %q, want nil", decoded.Output)
			}
			if name == "null" && string(decoded.Output) != "null" {
				t.Fatalf("explicit null output = %q, want null", decoded.Output)
			}
		})
	}
}

func TestTaskRequestPreservesExactJSONNumbers(t *testing.T) {
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/tasks", strings.NewReader(
		`{"asset_id":"asset-1","command":"fixture.queued","input":{"value":9007199254740993}}`,
	))
	var decoded createTaskRequest

	if !handler.decodeProtocolRequestBody(recorder, request, &decoded, false, protocol.ValidateTaskCreateRequest) {
		t.Fatalf("request rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	input, ok := decoded.Input.(map[string]any)
	if !ok {
		t.Fatalf("decoded input = %#v", decoded.Input)
	}
	value, ok := input["value"].(json.Number)
	if !ok || value.String() != "9007199254740993" {
		t.Fatalf("decoded exact number = %#v", input["value"])
	}
}

func TestTaskOutputPreservesExactJSONNumbers(t *testing.T) {
	output, err := decodeTaskOutput(json.RawMessage(`{"value":9007199254740993}`))
	if err != nil {
		t.Fatal(err)
	}
	value, ok := output.(map[string]any)["value"].(json.Number)
	if !ok || value.String() != "9007199254740993" {
		t.Fatalf("decoded exact output number = %#v", output)
	}
}

func TestEntityCheckInRejectsProtocolInvalidBodyBeforeActions(t *testing.T) {
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := withURLParam(
		routeRequest(http.MethodPost, "/entities/entity-1/checkin", `{"latitude":91}`),
		"entity_id",
		"entity-1",
	)

	handler.EntityCheckin(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
	}
}

func TestEntityCheckInRejectsMalformedJSON(t *testing.T) {
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := withURLParam(
		routeRequest(http.MethodPost, "/entities/entity-1/checkin", `{"latitude":`),
		"entity_id",
		"entity-1",
	)

	handler.EntityCheckin(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "INVALID_JSON" {
		t.Fatalf("error_code = %v, want INVALID_JSON", body["error_code"])
	}
}

func TestEntityCheckInRejectsTrailingJSON(t *testing.T) {
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := withURLParam(
		routeRequest(http.MethodPost, "/entities/entity-1/checkin", `{}{"status":"online"}`),
		"entity_id",
		"entity-1",
	)

	handler.EntityCheckin(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "INVALID_JSON" {
		t.Fatalf("error_code = %v, want INVALID_JSON", body["error_code"])
	}
}

func TestCreateEntityRejectsTrailingJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"entity-1","entity_type":"asset"}{"extra":true}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
}

func TestCreateEntityRejectsUnknownField(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"entity-1","entity_type":"asset","entity_typo":"vehicle"}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestCreateEntityRejectsOversizedBody(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	// Handler request bodies are capped at 1 MiB; exceed that limit by 64 bytes.
	oversizedValue := strings.Repeat("a", 1024*1024+64)
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"`+oversizedValue+`"}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "BODY_TOO_LARGE" {
		t.Fatalf("expected BODY_TOO_LARGE, got %v", body["error_code"])
	}
}

func TestCreateObjectRejectsTrailingJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/objects", `{"object_id":"object-1"}{"extra":true}`)

	handler.CreateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
}

func TestCreateObjectRejectsPayloadField(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/objects", `{"object_id":"object-1","payload":{"legacy":true}}`)

	handler.CreateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestCreateObjectRejectsBucketInput(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/objects", `{"object_id":"object-1","bucket":"client-bucket"}`)

	handler.CreateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestUpdateObjectRejectsBucketInput(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := withURLParam(routeRequest(http.MethodPatch, "/objects/object-1", `{"bucket":"client-bucket"}`), "object_id", "object-1")

	handler.UpdateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestCRUDRequestBodiesEnforceCanonicalProtocolBeforeActions(t *testing.T) {
	tests := []struct {
		name    string
		method  string
		path    string
		payload string
		handle  func(*Handler, http.ResponseWriter, *http.Request)
	}{
		{name: "entity create rejects explicit null", method: http.MethodPost, path: "/entities", payload: `{"entity_id":null,"entity_type":"asset"}`, handle: (*Handler).CreateEntity},
		{name: "entity update rejects empty patch", method: http.MethodPatch, path: "/entities/entity-1", payload: `{}`, handle: (*Handler).UpdateEntity},
		{name: "entity update rejects null type", method: http.MethodPatch, path: "/entities/entity-1", payload: `{"entity_type":null}`, handle: (*Handler).UpdateEntity},
		{name: "task create rejects client task id", method: http.MethodPost, path: "/tasks", payload: `{"task_id":"task-1","asset_id":"asset-1","command":"fixture.immediate","input":{}}`, handle: (*Handler).CreateTask},
		{name: "object create rejects client-owned size", method: http.MethodPost, path: "/objects", payload: `{"object_id":"object-1","size_bytes":1}`, handle: (*Handler).CreateObject},
		{name: "object update rejects empty patch", method: http.MethodPatch, path: "/objects/object-1", payload: `{}`, handle: (*Handler).UpdateObject},
		{name: "object update rejects client-owned content type", method: http.MethodPatch, path: "/objects/object-1", payload: `{"content_type":"image/png"}`, handle: (*Handler).UpdateObject},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := newTestHandler()
			recorder := httptest.NewRecorder()
			request := routeRequest(tt.method, tt.path, tt.payload)
			tt.handle(handler, recorder, request)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", recorder.Code)
			}
			if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
				t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
			}
		})
	}
}

func TestNullablePatchStringDistinguishesAbsentNullAndValue(t *testing.T) {
	var req struct {
		Absent nullablePatchString `json:"absent,omitempty"`
		Clear  nullablePatchString `json:"clear,omitempty"`
		Set    nullablePatchString `json:"set,omitempty"`
	}
	if err := json.Unmarshal([]byte(`{"clear":null,"set":"alias"}`), &req); err != nil {
		t.Fatalf("decode nullable patch strings: %v", err)
	}
	if req.Absent.actionValue() != nil {
		t.Fatal("absent nullable patch string should not produce an action value")
	}
	clear := req.Clear.actionValue()
	if clear == nil || *clear != "" {
		t.Fatalf("null nullable patch string action value = %#v, want empty string pointer", clear)
	}
	set := req.Set.actionValue()
	if set == nil || *set != "alias" {
		t.Fatalf("set nullable patch string action value = %#v, want alias", set)
	}
}

func TestCRUDHandlersRejectInvalidConformanceRequests(t *testing.T) {
	cases, err := conformance.LoadRequestValidationCases()
	if err != nil {
		t.Fatal(err)
	}
	type endpoint struct {
		method string
		path   string
		handle func(*Handler, http.ResponseWriter, *http.Request)
	}
	endpoints := map[string]endpoint{
		"EntityCreateRequest":        {method: http.MethodPost, path: "/entities", handle: (*Handler).CreateEntity},
		"EntityCheckInRequest":       {method: http.MethodPost, path: "/entities/entity-1/checkin", handle: (*Handler).EntityCheckin},
		"EntityUpdateRequest":        {method: http.MethodPatch, path: "/entities/entity-1", handle: (*Handler).UpdateEntity},
		"TaskCreateRequest":          {method: http.MethodPost, path: "/tasks", handle: (*Handler).CreateTask},
		"TaskAcknowledgeRequest":     {method: http.MethodPost, path: "/tasks/task-1/acknowledge", handle: (*Handler).AcknowledgeTask},
		"TaskStartRequest":           {method: http.MethodPost, path: "/tasks/task-1/start", handle: (*Handler).StartTask},
		"TaskProgressRequest":        {method: http.MethodPost, path: "/tasks/task-1/progress", handle: (*Handler).ProgressTask},
		"TaskCompleteRequest":        {method: http.MethodPost, path: "/tasks/task-1/complete", handle: (*Handler).CompleteTask},
		"TaskFailRequest":            {method: http.MethodPost, path: "/tasks/task-1/fail", handle: (*Handler).FailTask},
		"TaskCancelRequest":          {method: http.MethodPost, path: "/tasks/task-1/cancel", handle: (*Handler).CancelTask},
		"RuntimeRegistrationRequest": {method: http.MethodPost, path: "/entities/asset-1/runtime", handle: (*Handler).BeginAssetRuntime},
		"RuntimeStopRequest":         {method: http.MethodPost, path: "/entities/asset-1/runtime/stop", handle: (*Handler).StopAssetRuntime},
		"RuntimeReadyRequest":        {method: http.MethodPost, path: "/entities/asset-1/runtime/ready", handle: (*Handler).ReadyAssetRuntime},
		"ObjectCreateRequest":        {method: http.MethodPost, path: "/objects", handle: (*Handler).CreateObject},
		"ObjectUpdateRequest":        {method: http.MethodPatch, path: "/objects/object-1", handle: (*Handler).UpdateObject},
	}
	for _, testCase := range cases {
		if testCase.Valid {
			continue
		}
		t.Run(testCase.Name, func(t *testing.T) {
			endpoint, ok := endpoints[testCase.Definition]
			if !ok {
				t.Fatalf("no Core endpoint for %q", testCase.Definition)
			}
			handler := newTestHandler()
			recorder := httptest.NewRecorder()
			request := routeRequest(endpoint.method, endpoint.path, string(testCase.Value))

			endpoint.handle(handler, recorder, request)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", recorder.Code)
			}
			if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
				t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
			}
		})
	}
}

func TestEntityCheckinRejectsAggregatePolygonPositionLimit(t *testing.T) {
	exterior := make([]any, 5_001)
	interior := make([]any, 5_001)
	for index := range exterior {
		exterior[index] = []any{0.0, 0.0}
		interior[index] = []any{0.0, 0.0}
	}
	rings := []any{exterior, interior}
	payload, err := json.Marshal(map[string]any{
		"components": map[string]any{
			"geometry": map[string]any{"type": "Polygon", "coordinates": rings},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler()
	recorder := httptest.NewRecorder()
	request := withURLParam(routeRequest(http.MethodPost, "/entities/entity-1/checkin", string(payload)), "entity_id", "entity-1")

	handler.EntityCheckin(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
	}
}

func TestCreateEntityMapsOversizedPromotedStringTo400(t *testing.T) {
	handler := newTestHandler()
	handler.entityActions = actions.NewEntityActions(nil)
	recorder := httptest.NewRecorder()
	request := routeRequest(
		http.MethodPost,
		"/entities",
		`{"entity_id":"entity-length","entity_type":"`+strings.Repeat("a", 51)+`"}`,
	)

	handler.CreateEntity(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if body := decodeBody(t, recorder); body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("error_code = %v, want VALIDATION_ERROR", body["error_code"])
	}
}

func TestCreateTaskRequestMapsImmutableFields(t *testing.T) {
	params := createTaskRequest{AssetID: "asset-1", Command: "fixture.immediate", Input: map[string]any{"value": 1}}.actionParams()
	if params.AssetID != "asset-1" || params.Command != "fixture.immediate" {
		t.Fatalf("Task create params = %#v", params)
	}
}

func TestEntityCheckinRequestComponentUpdate(t *testing.T) {
	status := "online"
	latitude := 38.5
	heading := 91.25
	now := time.Date(2026, 6, 26, 12, 30, 0, 0, time.FixedZone("EDT", -4*60*60))
	wantTime := now.UTC().Format(time.RFC3339)

	got := checkinComponentUpdate(protocol.EntityCheckInRequest{
		Status:     &status,
		Latitude:   &latitude,
		HeadingDeg: &heading,
		Components: map[string]interface{}{
			"custom_test": "preserved",
		},
	}, now)

	if got["custom_test"] != "preserved" {
		t.Fatalf("custom component = %v, want preserved", got["custom_test"])
	}

	statusComponent, ok := got["status"].(map[string]interface{})
	if !ok {
		t.Fatalf("status component = %T, want map", got["status"])
	}
	if statusComponent["value"] != status || statusComponent["last_update"] != wantTime {
		t.Fatalf("status component = %#v, want value and last_update", statusComponent)
	}

	telemetry, ok := got["telemetry"].(map[string]interface{})
	if !ok {
		t.Fatalf("telemetry component = %T, want map", got["telemetry"])
	}
	if telemetry["latitude"] != latitude || telemetry["heading_deg"] != heading || telemetry["last_update"] != wantTime {
		t.Fatalf("telemetry component = %#v, want latitude, heading, and last_update", telemetry)
	}

	heartbeat, ok := got["heartbeat"].(map[string]interface{})
	if !ok {
		t.Fatalf("heartbeat component = %T, want map", got["heartbeat"])
	}
	if heartbeat["last_seen"] != wantTime {
		t.Fatalf("heartbeat last_seen = %v, want %s", heartbeat["last_seen"], wantTime)
	}
}

func TestParseListPaginationRejectsOffset(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/entities?limit=10&offset=0", nil)

	_, _, ok := handler.parseListPagination(rec, req)

	if ok {
		t.Fatal("expected offset pagination to be rejected")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestParseListPaginationReadsCursorAndSetsCursorHeaders(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/entities?limit=10&cursor=abc123", nil)

	limit, cursor, ok := handler.parseListPagination(rec, req)

	if !ok {
		t.Fatal("expected cursor pagination to parse")
	}
	if limit != 10 {
		t.Fatalf("expected limit 10, got %d", limit)
	}
	if cursor != "abc123" {
		t.Fatalf("expected cursor abc123, got %q", cursor)
	}

	setPaginationHeaders(rec, limit, 10, true, "next456")
	if rec.Header().Get("X-Limit") != "10" {
		t.Fatalf("expected X-Limit 10, got %q", rec.Header().Get("X-Limit"))
	}
	if rec.Header().Get("X-Returned-Count") != "10" {
		t.Fatalf("expected X-Returned-Count 10, got %q", rec.Header().Get("X-Returned-Count"))
	}
	if rec.Header().Get("X-Has-More") != "true" {
		t.Fatalf("expected X-Has-More true, got %q", rec.Header().Get("X-Has-More"))
	}
	if rec.Header().Get("X-Next-Cursor") != "next456" {
		t.Fatalf("expected X-Next-Cursor next456, got %q", rec.Header().Get("X-Next-Cursor"))
	}
	if rec.Header().Get("X-Total-Count") != "" || rec.Header().Get("X-Offset") != "" {
		t.Fatalf("old offset pagination headers should not be set: %#v", rec.Header())
	}
}

func TestGetChangedSinceRejectsMissingParam(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if body["message"] != "since_version parameter is required" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestGetChangedSinceRejectsOffset(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since_version=0&offset=0", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestGetChangedSinceRejectsBlankParam(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since_version=%20%20", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if body["message"] != "since_version parameter is required" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestGetChangedSinceRejectsInvalidVersion(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since_version=not-a-version", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	details, _ := body["details"].(map[string]interface{})
	errs, _ := details["errors"].([]interface{})
	if len(errs) == 0 {
		t.Fatalf("expected details.errors for invalid since")
	}
}

func TestFullDatasetVersionJSONPresence(t *testing.T) {
	response := serializeFullDatasetResult(&actions.FullDatasetResult{})
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal full dataset response: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode full dataset response: %v", err)
	}
	version, ok := decoded["version"]
	if !ok || version != float64(0) {
		t.Fatalf("full dataset response version = %#v, present %v; want required zero watermark", version, ok)
	}
}

func TestChangedSinceSerializesOrderedFeedEvents(t *testing.T) {
	response := serializeChangedSinceResult(&actions.ChangedSinceResult{
		Events: []protocol.FeedEvent{
			{Event: protocol.FeedEventUpdate, ResourceType: protocol.ResourceTypeTask, ID: "task-1", Version: 2, Resource: map[string]any{"task_id": "task-1", "asset_id": "asset-1", "command": "fixture.immediate", "input": map[string]any{}, "status": "pending", "created_at": "2026-08-19T12:00:00Z", "updated_at": "2026-08-19T12:00:00Z"}},
			{Event: protocol.FeedEventDelete, ResourceType: protocol.ResourceTypeObject, ID: "deleted-object", Version: 3},
		},
		Version: 3,
	})

	data, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal changed-since response: %v", err)
	}
	var decoded struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode changed-since response: %v", err)
	}
	if got := decoded.Events[0]["id"]; got != "task-1" {
		t.Fatalf("first event id = %v, want task-1", got)
	}
}

func TestQueryResponsesIncludeFalseHasMoreFlags(t *testing.T) {
	tests := []struct {
		name     string
		resp     interface{}
		keys     []string
		validate func(any) []string
	}{
		{
			name:     "full dataset",
			resp:     &protocol.FullDatasetResponse{Entities: []protocol.EntityResource{}, Tasks: []protocol.TaskResource{}, Objects: []protocol.ObjectDetailResource{}},
			keys:     []string{"has_more_entities", "has_more_tasks", "has_more_objects"},
			validate: protocol.ValidateFullDatasetResponse,
		},
		{
			name:     "changed since",
			resp:     &protocol.ChangedSinceResponse{Events: []protocol.FeedEvent{}, Version: 1},
			keys:     []string{"has_more"},
			validate: protocol.ValidateChangedSinceResponse,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := json.Marshal(tt.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if validationErrors := tt.validate(json.RawMessage(raw)); len(validationErrors) > 0 {
				t.Fatalf("response failed Atlas Protocol validation: %v", validationErrors)
			}
			var body map[string]interface{}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			for _, key := range tt.keys {
				got, ok := body[key]
				if !ok {
					t.Fatalf("expected %s to be present in %s", key, string(raw))
				}
				if got != false {
					t.Fatalf("expected %s=false, got %#v", key, got)
				}
			}
		})
	}
}
