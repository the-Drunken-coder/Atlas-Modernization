package actions

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

func TestPromotedStringLengthBoundaries(t *testing.T) {
	tests := []struct {
		field string
		limit int
	}{
		{field: "entity_type", limit: entityTypeMaxLength},
		{field: "subtype", limit: entitySubtypeMaxLength},
		{field: "path", limit: objectPathMaxLength},
		{field: "content_type", limit: objectContentMaxLength},
		{field: "type", limit: objectTypeMaxLength},
	}

	for _, tt := range tests {
		t.Run(tt.field, func(t *testing.T) {
			if err := validateStringMaxLength(tt.field, strings.Repeat("é", tt.limit), tt.limit); err != nil {
				t.Fatalf("maximum-length value rejected: %v", err)
			}

			err := validateStringMaxLength(tt.field, strings.Repeat("é", tt.limit+1), tt.limit)
			var validationErr *ValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("maximum-plus-one error = %T %v, want ValidationError", err, err)
			}
		})
	}
}

func TestCanonicalStringLimitsApplyBeforeWhitespaceNormalization(t *testing.T) {
	if err := ValidateEntityID(" " + strings.Repeat("a", IDMaxLength) + " "); err == nil {
		t.Fatal("expected raw overlong entity ID to be rejected")
	}
	if _, err := NormalizeAlias(" " + strings.Repeat("a", 255) + " "); err == nil {
		t.Fatal("expected raw overlong alias to be rejected")
	}

	entityActions := NewEntityActions(nil)
	if _, err := entityActions.Create(context.Background(), CreateEntityParams{
		EntityID:   "entity-whitespace-limit",
		EntityType: " " + strings.Repeat("a", entityTypeMaxLength) + " ",
	}); err == nil {
		t.Fatal("expected raw overlong entity type to be rejected")
	}

	objectType := " " + strings.Repeat("a", objectTypeMaxLength) + " "
	if _, err := NewObjectActions(nil, nil).Create(context.Background(), CreateObjectParams{
		ObjectID: "object-whitespace-limit",
		Type:     &objectType,
	}); err == nil {
		t.Fatal("expected raw overlong object type to be rejected")
	}
}

func TestEntityActionsRejectOversizedPromotedStringsBeforeDatabase(t *testing.T) {
	tests := []struct {
		name   string
		create CreateEntityParams
		update UpdateEntityParams
	}{
		{
			name: "create entity type",
			create: CreateEntityParams{
				EntityID:   "entity-length-create-type",
				EntityType: strings.Repeat("a", entityTypeMaxLength+1),
			},
		},
		{
			name: "create subtype",
			create: CreateEntityParams{
				EntityID:   "entity-length-create-subtype",
				EntityType: "asset",
				Subtype:    strings.Repeat("a", entitySubtypeMaxLength+1),
			},
		},
		{
			name: "update entity type",
			update: UpdateEntityParams{
				EntityType: ptrString(strings.Repeat("a", entityTypeMaxLength+1)),
			},
		},
		{
			name: "update subtype",
			update: UpdateEntityParams{
				Subtype: ptrString(strings.Repeat("a", entitySubtypeMaxLength+1)),
			},
		},
	}

	actions := NewEntityActions(nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var err error
			if tt.create.EntityID != "" {
				_, err = actions.Create(context.Background(), tt.create)
			} else {
				_, err = actions.Update(context.Background(), "entity-length-update", tt.update)
			}
			assertPromotedStringValidationError(t, err)
		})
	}
}

func TestObjectActionsRejectOversizedPromotedStringsBeforeDatabaseOrStorage(t *testing.T) {
	oversizedPath := strings.Repeat("p", objectPathMaxLength+1)
	oversizedContentType := strings.Repeat("c", objectContentMaxLength+1)
	oversizedType := strings.Repeat("t", objectTypeMaxLength+1)

	createTests := []CreateObjectParams{
		{ObjectID: "object-length-create-type", Type: &oversizedType},
	}
	updateTests := []UpdateObjectParams{
		{Type: &oversizedType},
	}

	actions := NewObjectActions(nil, nil)
	for i, params := range createTests {
		_, err := actions.Create(context.Background(), params)
		if err == nil {
			t.Fatalf("create case %d returned no error", i)
		}
		assertPromotedStringValidationError(t, err)
	}
	for i, params := range updateTests {
		_, err := actions.Update(context.Background(), "object-length-update", params)
		if err == nil {
			t.Fatalf("update case %d returned no error", i)
		}
		assertPromotedStringValidationError(t, err)
	}

	uploadStorage := &boundaryObjectStorage{path: "objects/object-length-upload/blob"}
	uploadActions := NewObjectActions(nil, uploadStorage)
	for _, input := range []struct {
		contentType string
		objectType  string
	}{
		{contentType: oversizedContentType},
		{contentType: "application/octet-stream", objectType: oversizedType},
	} {
		_, err := uploadActions.Upload(context.Background(), "object-length-upload", strings.NewReader("x"), 1, input.contentType, input.objectType, nil)
		assertPromotedStringValidationError(t, err)
	}
	if uploadStorage.pathCalls != 0 || uploadStorage.uploadCalls != 0 {
		t.Fatalf("oversized upload reached storage: path calls = %d, upload calls = %d", uploadStorage.pathCalls, uploadStorage.uploadCalls)
	}

	overlongPathStorage := &boundaryObjectStorage{path: oversizedPath}
	_, err := NewObjectActions(nil, overlongPathStorage).Upload(
		context.Background(),
		"object-length-upload-path",
		strings.NewReader("x"),
		1,
		"application/octet-stream",
		"data",
		nil,
	)
	assertPromotedStringValidationError(t, err)
	if overlongPathStorage.uploadCalls != 0 {
		t.Fatalf("overlong generated path reached blob upload %d time(s)", overlongPathStorage.uploadCalls)
	}
}

func TestPromotedStringMaximumsAcceptedByActions(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "length-boundary-"
	defer cleanupActionsLiveRows(ctx, t, pool, prefix)

	entityActions := NewEntityActions(pool)
	entity, err := entityActions.Create(ctx, CreateEntityParams{
		EntityID:   prefix + "entity",
		EntityType: strings.Repeat("e", entityTypeMaxLength),
		Subtype:    strings.Repeat("s", entitySubtypeMaxLength),
	})
	if err != nil {
		t.Fatalf("create entity with maximum-length fields: %v", err)
	}
	updatedEntityType := strings.Repeat("u", entityTypeMaxLength)
	updatedSubtype := strings.Repeat("v", entitySubtypeMaxLength)
	if _, err := entityActions.Update(ctx, entity.EntityID, UpdateEntityParams{
		EntityType: &updatedEntityType,
		Subtype:    &updatedSubtype,
	}); err != nil {
		t.Fatalf("update entity with maximum-length fields: %v", err)
	}

	objectActions := NewObjectActions(pool, nil)
	contentType := strings.Repeat("c", objectContentMaxLength)
	objectType := strings.Repeat("t", objectTypeMaxLength)
	object, err := objectActions.Create(ctx, CreateObjectParams{
		ObjectID: prefix + "object",
		Type:     &objectType,
	})
	if err != nil {
		t.Fatalf("create object with maximum-length fields: %v", err)
	}
	if _, err := objectActions.Update(ctx, object.ObjectID, UpdateObjectParams{
		Type: &objectType,
	}); err != nil {
		t.Fatalf("update object with maximum-length fields: %v", err)
	}

	uploadStorage := &boundaryObjectStorage{path: "upload-" + strings.Repeat("p", objectPathMaxLength-len("upload-"))}
	if _, err := NewObjectActions(pool, uploadStorage).Upload(
		ctx,
		prefix+"upload",
		strings.NewReader("x"),
		1,
		contentType,
		objectType,
		nil,
	); err != nil {
		t.Fatalf("upload object with maximum-length fields: %v", err)
	}
}

func assertPromotedStringValidationError(t *testing.T, err error) {
	t.Helper()
	var validationErr *ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("error = %T %v, want ValidationError", err, err)
	}
	if !strings.Contains(validationErr.Error(), "must not exceed") {
		t.Fatalf("validation error = %q, want length limit", validationErr.Error())
	}
}

type boundaryObjectStorage struct {
	path        string
	pathCalls   int
	uploadCalls int
}

func (s *boundaryObjectStorage) Bucket() string { return "atlas-media" }

func (s *boundaryObjectStorage) DeleteObjectPath(context.Context, string) error { return nil }

func (s *boundaryObjectStorage) NewObjectPath(string) string {
	s.pathCalls++
	return s.path
}

func (s *boundaryObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (s *boundaryObjectStorage) UploadObjectFromReaderToPath(_ context.Context, objectID, path string, _ io.Reader, size int64, contentType string) (*storage.ObjectInfo, error) {
	s.uploadCalls++
	return &storage.ObjectInfo{
		ObjectID:    objectID,
		Bucket:      s.Bucket(),
		Path:        path,
		SizeBytes:   size,
		ContentType: contentType,
	}, nil
}
