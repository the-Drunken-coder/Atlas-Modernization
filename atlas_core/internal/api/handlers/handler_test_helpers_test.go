package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func newTestHandler() *Handler {
	return &Handler{
		logger: zerolog.Nop(),
		config: &config.Config{
			MaxViewSizeMB:   10,
			MaxUploadSizeMB: 100,
		},
	}
}
func assertPanicContains(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatalf("expected panic containing %q", want)
		}
		if !strings.Contains(fmt.Sprint(recovered), want) {
			t.Fatalf("panic = %v, want substring %q", recovered, want)
		}
	}()
	fn()
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}
	return body
}

func findLogEvent(t *testing.T, logs, message string) map[string]interface{} {
	t.Helper()

	for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
		var event map[string]interface{}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("failed to decode log event: %v", err)
		}
		if event["message"] == message {
			return event
		}
	}
	t.Fatalf("log message %q not found in %q", message, logs)
	return nil
}

func routeRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}
func multipartUploadRequest(t *testing.T, fields map[string]string, fileSize int) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("write field %q: %v", key, err)
		}
	}
	file, err := writer.CreateFormFile("file", "upload.bin")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := file.Write(bytes.Repeat([]byte("a"), fileSize)); err != nil {
		t.Fatalf("write file body: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/objects/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func withURLParam(req *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

type testError string

func (e testError) Error() string {
	return string(e)
}
