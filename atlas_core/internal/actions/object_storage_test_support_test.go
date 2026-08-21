package actions

import (
	"context"
	"io"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

type noopObjectStorage struct{}

var _ objectStorage = (*noopObjectStorage)(nil)

func (*noopObjectStorage) Bucket() string { return "atlas-media" }

func (*noopObjectStorage) DeleteObjectPath(context.Context, string) error { return nil }

func (*noopObjectStorage) NewObjectPath(objectID string) string {
	return "objects/" + objectID + "/blob"
}

func (*noopObjectStorage) StreamObjectPath(context.Context, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (*noopObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}
