package actions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

func TestNormalizeOptionalObjectString(t *testing.T) {
	tests := []struct {
		name  string
		value *string
		want  *string
	}{
		{name: "nil remains nil"},
		{name: "empty becomes nil", value: ptrString("")},
		{name: "whitespace becomes nil", value: ptrString(" \t\n ")},
		{name: "trimmed value", value: ptrString("  photo  "), want: ptrString("photo")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeOptionalObjectString(tt.value)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("normalizeOptionalObjectString() = %q, want nil", *got)
				}
				return
			}
			if got == nil || *got != *tt.want {
				t.Fatalf("normalizeOptionalObjectString() = %v, want %q", got, *tt.want)
			}
		})
	}
}

func TestDecodeObjectJSONForPatchPreservesLargeIntegers(t *testing.T) {
	data, err := decodeObjectJSONForPatch(json.RawMessage(`{"size_bytes":9007199254740993,"extra":"patched"}`))
	if err != nil {
		t.Fatalf("decodeObjectJSONForPatch: %v", err)
	}

	size, ok := data["size_bytes"].(json.Number)
	if !ok {
		t.Fatalf("size_bytes type = %T, want json.Number", data["size_bytes"])
	}
	got, err := size.Int64()
	if err != nil {
		t.Fatalf("size_bytes Int64: %v", err)
	}
	if got != 9007199254740993 {
		t.Fatalf("size_bytes = %d, want exact large integer", got)
	}
}

func TestDecodeObjectJSONForPatchRejectsTrailingData(t *testing.T) {
	if _, err := decodeObjectJSONForPatch(json.RawMessage(`{"size_bytes":1024}{"extra":"bad"}`)); err == nil {
		t.Fatal("expected trailing data to fail")
	}
}

func TestCleanupUploadedPathAfterFailureDeletesUploadedObject(t *testing.T) {
	storageClient := &recordingObjectStorage{}
	actions := &ObjectActions{storage: storageClient}
	cause := errors.New("commit failed")

	err := actions.cleanupUploadedPathAfterFailure(context.Background(), "obj-1", "objects/obj-1/blob", cause)

	if !errors.Is(err, cause) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause %v", err, cause)
	}
	if len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != "objects/obj-1/blob" {
		t.Fatalf("deleted paths = %#v, want uploaded path", storageClient.deletedPaths)
	}
}

func TestCleanupUploadedPathAfterFailureReportsDeleteFailure(t *testing.T) {
	storageClient := &recordingObjectStorage{deleteErr: errors.New("delete failed")}
	actions := &ObjectActions{storage: storageClient}
	cause := errors.New("commit failed")

	err := actions.cleanupUploadedPathAfterFailure(context.Background(), "obj-1", "objects/obj-1/blob", cause)

	if !errors.Is(err, cause) || !errors.Is(err, storageClient.deleteErr) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause and delete error", err)
	}
	if !strings.Contains(err.Error(), "objects/obj-1/blob") {
		t.Fatalf("cleanup error should include uploaded path, got %q", err.Error())
	}
}

func ptrString(value string) *string {
	return &value
}

type recordingObjectStorage struct {
	deletedPaths []string
	deleteErr    error
}

func (s *recordingObjectStorage) Bucket() string {
	return "atlas-media"
}

func (s *recordingObjectStorage) DeleteObjectPath(_ context.Context, path string) error {
	s.deletedPaths = append(s.deletedPaths, path)
	return s.deleteErr
}

func (s *recordingObjectStorage) NewObjectPath(objectID string) string {
	return objectID
}

func (s *recordingObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (s *recordingObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}
