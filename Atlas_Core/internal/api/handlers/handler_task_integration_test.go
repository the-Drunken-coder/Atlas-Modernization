package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func TestAcknowledgeTaskHandlerIsIdempotent(t *testing.T) {
	pool := openFeedIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	taskID := fmt.Sprintf("handler-ack-idempotent-%d", time.Now().UTC().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM tasks WHERE task_id = $1`, taskID); err != nil {
			t.Errorf("cleanup task %q: %v", taskID, err)
		}
	})

	sink := &handlerTaskChangeSink{changes: make(chan actions.ResourceChange, 4)}
	taskActions := actions.NewTaskActionsWithChangeSink(pool, sink)
	handler := &Handler{taskActions: taskActions, logger: zerolog.Nop(), config: &config.Config{}}
	router := chi.NewRouter()
	router.Post("/tasks/{task_id}/acknowledge", handler.AcknowledgeTask)

	created, err := taskActions.Create(ctx, actions.CreateTaskParams{TaskID: taskID})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	receiveHandlerTaskChange(t, sink.changes)

	acknowledged := acknowledgeTaskHandler(t, router, taskID, serializers.StrongETag(created.Version), http.StatusOK)
	if acknowledged.Status != "acknowledged" || acknowledged.Metadata.Version <= created.Version {
		t.Fatalf("acknowledged task = %#v, want acknowledged after version %d", acknowledged, created.Version)
	}
	change := receiveHandlerTaskChange(t, sink.changes)
	if change.Event != actions.ChangeEventUpdate || change.ID != taskID || change.Version != acknowledged.Metadata.Version {
		t.Fatalf("acknowledgement change = %#v, want task update at version %d", change, acknowledged.Metadata.Version)
	}

	repeated := acknowledgeTaskHandler(t, router, taskID, serializers.StrongETag(acknowledged.Metadata.Version), http.StatusOK)
	assertSameTaskResponseVersionAndTimestamp(t, repeated, acknowledged)
	assertNoHandlerTaskChange(t, sink.changes)

	repeated = acknowledgeTaskHandler(t, router, taskID, "", http.StatusOK)
	assertSameTaskResponseVersionAndTimestamp(t, repeated, acknowledged)
	assertNoHandlerTaskChange(t, sink.changes)

	acknowledgeTaskHandler(t, router, taskID, serializers.StrongETag(created.Version), http.StatusPreconditionFailed)
	assertNoHandlerTaskChange(t, sink.changes)
}

type handlerTaskChangeSink struct {
	changes chan actions.ResourceChange
}

func (s *handlerTaskChangeSink) PublishResourceChange(change actions.ResourceChange) {
	s.changes <- change
}

func acknowledgeTaskHandler(t *testing.T, router http.Handler, taskID, ifMatch string, wantStatus int) *serializers.TaskResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/tasks/"+taskID+"/acknowledge", nil)
	if ifMatch != "" {
		req.Header.Set("If-Match", ifMatch)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("POST /tasks/%s/acknowledge status = %d, want %d, body=%s", taskID, rec.Code, wantStatus, rec.Body.String())
	}
	if wantStatus != http.StatusOK {
		return nil
	}
	var task serializers.TaskResponse
	if err := json.NewDecoder(rec.Body).Decode(&task); err != nil {
		t.Fatalf("decode acknowledgement response: %v", err)
	}
	wantETag := serializers.StrongETag(task.Metadata.Version)
	if got := rec.Header().Get("ETag"); got != wantETag {
		t.Fatalf("acknowledgement ETag = %q, want %q", got, wantETag)
	}
	return &task
}

func assertSameTaskResponseVersionAndTimestamp(t *testing.T, got, want *serializers.TaskResponse) {
	t.Helper()
	if got.Metadata.Version != want.Metadata.Version || got.Metadata.UpdatedAt != want.Metadata.UpdatedAt {
		t.Fatalf("task version/updated_at = %d/%s, want %d/%s", got.Metadata.Version, got.Metadata.UpdatedAt, want.Metadata.Version, want.Metadata.UpdatedAt)
	}
}

func assertNoHandlerTaskChange(t *testing.T, changes <-chan actions.ResourceChange) {
	t.Helper()
	select {
	case change := <-changes:
		t.Fatalf("unexpected handler task change: %#v", change)
	default:
	}
}

func receiveHandlerTaskChange(t *testing.T, changes <-chan actions.ResourceChange) actions.ResourceChange {
	t.Helper()
	select {
	case change := <-changes:
		return change
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for handler task change")
		return actions.ResourceChange{}
	}
}
