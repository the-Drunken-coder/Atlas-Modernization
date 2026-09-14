package actions

import (
	"context"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
	"github.com/the-drunken-coder/atlas/services/core/internal/testenv"
)

const (
	storageRecoveryEndpointEnv  = "ATLAS_STORAGE_RECOVERY_ENDPOINT"
	storageRecoveryAccessKeyEnv = "ATLAS_STORAGE_RECOVERY_ACCESS_KEY"
	storageRecoverySecretKeyEnv = "ATLAS_STORAGE_RECOVERY_SECRET_KEY"
)

type noopObjectStorage struct{}

var _ objectStorage = (*noopObjectStorage)(nil)

func (*noopObjectStorage) Bucket() string { return "atlas-media" }

func (*noopObjectStorage) DeleteObjectPath(context.Context, string, string) error { return nil }

func (*noopObjectStorage) NewObjectPath(objectID string) string {
	return "objects/" + objectID + "/blob"
}

func (*noopObjectStorage) StreamObjectPath(context.Context, string, string, string) (io.ReadCloser, *storage.ObjectInfo, error) {
	return nil, nil, nil
}

func (*noopObjectStorage) UploadObjectFromReaderToPath(context.Context, string, string, io.Reader, int64, string) (*storage.ObjectInfo, error) {
	return nil, nil
}

func newIsolatedStorageRecoveryClient(t testing.TB) *storage.Client {
	t.Helper()
	bucket := "atlas-recovery-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	client := newStorageRecoveryClient(t, bucket)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := client.EnsureBucket(ctx); err != nil {
		t.Fatalf("create isolated storage recovery bucket %q: %v", bucket, err)
	}
	t.Logf("isolated MinIO bucket: %s", bucket)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		if err := client.EmptyBucket(cleanupCtx); err != nil {
			t.Errorf("empty isolated storage recovery bucket %q: %v", bucket, err)
		}
	})
	return client
}

func newStorageRecoveryClient(t testing.TB, bucket string) *storage.Client {
	t.Helper()
	endpoint, endpointSet := os.LookupEnv(storageRecoveryEndpointEnv)
	accessKey, accessKeySet := os.LookupEnv(storageRecoveryAccessKeyEnv)
	secretKey, secretKeySet := os.LookupEnv(storageRecoverySecretKeyEnv)
	if !endpointSet && !accessKeySet && !secretKeySet {
		testenv.SkipOrFatal(t, "set %s, %s, and %s to run real storage recovery tests", storageRecoveryEndpointEnv, storageRecoveryAccessKeyEnv, storageRecoverySecretKeyEnv)
	}
	if strings.TrimSpace(endpoint) == "" || strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
		t.Fatalf("%s, %s, and %s must all be non-empty", storageRecoveryEndpointEnv, storageRecoveryAccessKeyEnv, storageRecoverySecretKeyEnv)
	}
	host, _, err := net.SplitHostPort(endpoint)
	if err != nil {
		t.Fatalf("parse %s: %v", storageRecoveryEndpointEnv, err)
	}
	address := net.ParseIP(strings.Trim(host, "[]"))
	if !strings.EqualFold(host, "localhost") && (address == nil || !address.IsLoopback()) {
		t.Fatalf("%s must target loopback, got %q", storageRecoveryEndpointEnv, endpoint)
	}

	client, err := storage.NewClient(&config.Config{
		MinIOEndpoint:  endpoint,
		MinIOAccessKey: accessKey,
		MinIOSecretKey: secretKey,
		MinioBucket:    bucket,
		MinIOSecure:    false,
	})
	if err != nil {
		t.Fatalf("configure isolated storage recovery client: %v", err)
	}
	return client
}

func newStorageRecoveryObjectID(t testing.TB) string {
	t.Helper()
	objectID := "sr-" + uuid.NewString()
	if len(objectID) > 50 {
		t.Fatalf("storage recovery object ID is %d characters, want at most 50", len(objectID))
	}
	return objectID
}
