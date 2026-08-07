// Package storage provides MinIO/S3-compatible object storage operations.
package storage

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

// StorageError is a base error for storage operations.
type StorageError struct {
	Message string
	Err     error
}

func (e *StorageError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *StorageError) Unwrap() error {
	return e.Err
}

// ObjectNotFoundError is returned when an object is not found.
type ObjectNotFoundError struct {
	Bucket     string
	ObjectName string
}

func (e *ObjectNotFoundError) Error() string {
	return fmt.Sprintf("object not found: %s/%s", e.Bucket, e.ObjectName)
}

// BucketNotFoundError is returned when a bucket is not found.
type BucketNotFoundError struct {
	Bucket string
}

func (e *BucketNotFoundError) Error() string {
	return fmt.Sprintf("bucket not found: %s", e.Bucket)
}

// ObjectInfo contains information about a stored object.
type ObjectInfo struct {
	ObjectID     string
	Bucket       string
	Path         string
	SizeBytes    int64
	ContentType  string
	ETag         string
	LastModified time.Time
}

// Client provides operations for MinIO/S3-compatible storage.
type Client struct {
	client   *minio.Client
	bucket   string
	endpoint string
	secure   bool
	region   string
}

// NewClient creates a new storage client.
func NewClient(cfg *config.Config) (*Client, error) {
	if cfg == nil {
		return nil, &StorageError{Message: "storage config is nil"}
	}
	if strings.TrimSpace(cfg.MinIOSecretKey) == "" {
		return nil, &StorageError{Message: "MinIO secret key not configured (set MINIO_SECRET_KEY or MINIO_SECRET_KEY_FILE)"}
	}
	if strings.TrimSpace(cfg.MinIOAccessKey) == "" {
		return nil, &StorageError{Message: "MinIO access key not configured (set MINIO_ACCESS_KEY)"}
	}
	if strings.TrimSpace(cfg.MinIOEndpoint) == "" {
		return nil, &StorageError{Message: "MinIO endpoint not configured (set MINIO_ENDPOINT)"}
	}
	if strings.TrimSpace(cfg.MinioBucket) == "" {
		return nil, &StorageError{Message: "MinIO bucket not configured (set MINIO_BUCKET)"}
	}

	client, err := minio.New(cfg.MinIOEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinIOAccessKey, cfg.MinIOSecretKey, ""),
		Secure: cfg.MinIOSecure,
		Region: cfg.MinIORegion,
	})
	if err != nil {
		return nil, &StorageError{Message: "failed to create MinIO client", Err: err}
	}

	return &Client{
		client:   client,
		bucket:   cfg.MinioBucket,
		endpoint: cfg.MinIOEndpoint,
		secure:   cfg.MinIOSecure,
		region:   cfg.MinIORegion,
	}, nil
}

// EnsureBucket ensures the bucket exists, creating it if necessary.
func (c *Client) EnsureBucket(ctx context.Context) error {
	exists, err := c.client.BucketExists(ctx, c.bucket)
	if err != nil {
		return &StorageError{Message: "failed to check bucket existence", Err: err}
	}
	if !exists {
		if err := c.client.MakeBucket(ctx, c.bucket, minio.MakeBucketOptions{Region: c.region}); err != nil {
			code := minio.ToErrorResponse(err).Code
			if code == "BucketAlreadyOwnedByYou" || code == "BucketAlreadyExists" {
				return nil
			}
			existsAfter, err2 := c.client.BucketExists(ctx, c.bucket)
			if err2 != nil {
				return &StorageError{
					Message: "failed to confirm bucket existence after create attempt",
					Err:     fmt.Errorf("make bucket failed: %w; bucket exists check failed: %w", err, err2),
				}
			}
			if existsAfter {
				return nil
			}
			return &StorageError{Message: "failed to create bucket", Err: err}
		}
	}
	return nil
}

// BucketExists checks if the configured bucket exists.
func (c *Client) BucketExists(ctx context.Context) (bool, error) {
	return c.client.BucketExists(ctx, c.bucket)
}

// EmptyBucket removes every object in the configured bucket without deleting the bucket or bucket policy.
func (c *Client) EmptyBucket(ctx context.Context) error {
	objects := c.client.ListObjects(ctx, c.bucket, minio.ListObjectsOptions{Recursive: true})
	for object := range objects {
		if object.Err != nil {
			code := minio.ToErrorResponse(object.Err).Code
			if code == "NoSuchBucket" {
				return &BucketNotFoundError{Bucket: c.bucket}
			}
			return &StorageError{Message: "failed to list bucket objects", Err: object.Err}
		}
		if err := c.client.RemoveObject(ctx, c.bucket, object.Key, minio.RemoveObjectOptions{}); err != nil {
			code := minio.ToErrorResponse(err).Code
			if code == "NoSuchKey" {
				continue
			}
			if code == "NoSuchBucket" {
				return &BucketNotFoundError{Bucket: c.bucket}
			}
			return &StorageError{Message: "failed to empty bucket", Err: err}
		}
	}
	return nil
}

// Bucket returns the configured bucket name.
func (c *Client) Bucket() string {
	return c.bucket
}

// NewObjectPath returns a durable unique storage path for a new object blob version.
func (c *Client) NewObjectPath(objectID string) string {
	return fmt.Sprintf("objects/%s/%d", objectID, time.Now().UTC().UnixNano())
}

func (c *Client) putObject(ctx context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*ObjectInfo, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	info, err := c.client.PutObject(ctx, c.bucket, path, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		if minio.ToErrorResponse(err).Code == "NoSuchBucket" {
			return nil, &BucketNotFoundError{Bucket: c.bucket}
		}
		return nil, &StorageError{Message: "failed to upload object", Err: err}
	}

	return &ObjectInfo{
		ObjectID:    objectID,
		Bucket:      c.bucket,
		Path:        path,
		SizeBytes:   info.Size,
		ContentType: contentType,
		ETag:        info.ETag,
	}, nil
}

// UploadObjectFromReaderToPath uploads an object to an explicit storage path.
func (c *Client) UploadObjectFromReaderToPath(ctx context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*ObjectInfo, error) {
	return c.putObject(ctx, objectID, path, reader, size, contentType)
}

// StreamObjectPath returns an io.ReadCloser for streaming an object from an explicit storage path.
func (c *Client) StreamObjectPath(ctx context.Context, objectID, path string) (io.ReadCloser, *ObjectInfo, error) {
	obj, err := c.client.GetObject(ctx, c.bucket, path, minio.GetObjectOptions{})
	if err != nil {
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchBucket":
			return nil, nil, &BucketNotFoundError{Bucket: c.bucket}
		case "NoSuchKey":
			return nil, nil, &ObjectNotFoundError{Bucket: c.bucket, ObjectName: path}
		default:
			return nil, nil, &StorageError{Message: "failed to get object", Err: err}
		}
	}

	stat, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchBucket":
			return nil, nil, &BucketNotFoundError{Bucket: c.bucket}
		case "NoSuchKey":
			return nil, nil, &ObjectNotFoundError{Bucket: c.bucket, ObjectName: path}
		default:
			return nil, nil, &StorageError{Message: "failed to stat object", Err: err}
		}
	}

	info := &ObjectInfo{
		ObjectID:     objectID,
		Bucket:       c.bucket,
		Path:         path,
		SizeBytes:    stat.Size,
		ContentType:  stat.ContentType,
		ETag:         stat.ETag,
		LastModified: stat.LastModified,
	}

	return obj, info, nil
}

// DeleteObjectPath deletes an object by its storage path.
func (c *Client) DeleteObjectPath(ctx context.Context, path string) error {
	err := c.client.RemoveObject(ctx, c.bucket, path, minio.RemoveObjectOptions{})
	if err != nil {
		code := minio.ToErrorResponse(err).Code
		if code == "NoSuchKey" {
			return nil
		}
		if code == "NoSuchBucket" {
			return &BucketNotFoundError{Bucket: c.bucket}
		}
		return &StorageError{Message: "failed to delete object", Err: err}
	}
	return nil
}
