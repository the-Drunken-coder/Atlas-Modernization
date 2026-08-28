package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/testenv"
)

func TestLiveStorageObjectLifecycle(t *testing.T) {
	bucket := fmt.Sprintf("atlas-storage-live-%d", time.Now().UTC().UnixNano())
	client := newLiveStorageClient(t, bucket)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := client.EnsureBucket(ctx); err != nil {
		testenv.SkipOrFatal(t, "live MinIO unavailable: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if err := client.EmptyBucket(cleanupCtx); err != nil {
			t.Errorf("empty live test bucket %q: %v", bucket, err)
		}
	})

	if err := client.EmptyBucket(ctx); err != nil {
		t.Fatalf("EmptyBucket on empty bucket: %v", err)
	}
	objectID := "storage-live-object"
	path := client.NewObjectPath(objectID)
	info, err := client.UploadObjectFromReaderToPath(ctx, objectID, path, strings.NewReader("storage body"), int64(len("storage body")), "text/plain")
	if err != nil {
		t.Fatalf("UploadObjectFromReaderToPath: %v", err)
	}
	if info.Bucket != bucket || info.Path != path || info.SizeBytes != int64(len("storage body")) || info.ContentType != "text/plain" {
		t.Fatalf("uploaded object info = %#v", info)
	}

	reader, streamedInfo, err := client.StreamObjectPath(ctx, objectID, path)
	if err != nil {
		t.Fatalf("StreamObjectPath: %v", err)
	}
	body, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil {
		t.Fatalf("read streamed object: %v", readErr)
	}
	if closeErr != nil {
		t.Fatalf("close streamed object: %v", closeErr)
	}
	if string(body) != "storage body" || streamedInfo.Path != path || streamedInfo.SizeBytes != int64(len("storage body")) {
		t.Fatalf("streamed body/info = %q %#v", string(body), streamedInfo)
	}

	if err := client.DeleteObjectPath(ctx, path); err != nil {
		t.Fatalf("DeleteObjectPath: %v", err)
	}
	if _, _, err := client.StreamObjectPath(ctx, objectID, path); !isObjectNotFound(err) {
		t.Fatalf("StreamObjectPath deleted object error = %v, want ObjectNotFoundError", err)
	}
	if err := client.DeleteObjectPath(ctx, path); err != nil {
		t.Fatalf("DeleteObjectPath missing key should be idempotent: %v", err)
	}
	if err := client.EmptyBucket(ctx); err != nil {
		t.Fatalf("EmptyBucket after delete: %v", err)
	}
}

func TestLiveStorageMissingBucketErrors(t *testing.T) {
	missingBucket := fmt.Sprintf("atlas-storage-missing-%d", time.Now().UTC().UnixNano())
	client := newLiveStorageClient(t, missingBucket)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	err := client.EmptyBucket(ctx)
	if err == nil {
		t.Fatal("EmptyBucket missing bucket succeeded, want BucketNotFoundError")
	}
	if !isBucketNotFound(err) {
		testenv.SkipOrFatal(t, "live MinIO unavailable or returned unexpected missing-bucket error: %v", err)
	}
}

func newLiveStorageClient(t *testing.T, bucket string) *Client {
	t.Helper()
	secret := firstNonEmptyEnv("MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD")
	if secret == "" {
		testenv.SkipOrFatal(t, "set MINIO_SECRET_KEY or MINIO_ROOT_PASSWORD to run live storage tests")
	}
	client, err := NewClient(&config.Config{
		MinIOEndpoint:  firstNonEmptyEnvOrDefault("MINIO_ENDPOINT", "localhost:9000"),
		MinIOAccessKey: firstNonEmptyEnvOrDefault("MINIO_ACCESS_KEY", firstNonEmptyEnvOrDefault("MINIO_ROOT_USER", "atlas")),
		MinIOSecretKey: secret,
		MinioBucket:    bucket,
		MinIOSecure:    false,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func firstNonEmptyEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func firstNonEmptyEnvOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func isObjectNotFound(err error) bool {
	var target *ObjectNotFoundError
	return errors.As(err, &target)
}

func isBucketNotFound(err error) bool {
	var target *BucketNotFoundError
	return errors.As(err, &target)
}
