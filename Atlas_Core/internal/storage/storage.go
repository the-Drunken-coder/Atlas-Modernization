// Package storage provides MinIO/S3-compatible object storage operations.
package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/rs/zerolog/log"
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
	client        *minio.Client
	presignClient *minio.Client // endpoint/host matches URLs returned to clients (SigV4)
	bucket        string
	endpoint      string
	secure        bool
	region        string
}

// NewClient creates a new storage client.
func NewClient(cfg *config.Config) (*Client, error) {
	if cfg == nil {
		return nil, &StorageError{Message: "storage config is nil"}
	}
	if cfg.MinIOSecretKey == "" {
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

	presignHost, presignSecure := cfg.MinIOEndpoint, cfg.MinIOSecure
	if ext := strings.TrimSpace(cfg.MinIOExternalEndpoint); ext != "" {
		presignHost, presignSecure, err = parseMinIOHostAndSecure(ext, cfg.MinIOSecure)
		if err != nil {
			return nil, &StorageError{Message: "invalid MINIO_EXTERNAL_ENDPOINT", Err: err}
		}
	}

	presignClient := client
	if presignHost != cfg.MinIOEndpoint || presignSecure != cfg.MinIOSecure {
		presignClient, err = minio.New(presignHost, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.MinIOAccessKey, cfg.MinIOSecretKey, ""),
			Secure: presignSecure,
			Region: cfg.MinIORegion,
		})
		if err != nil {
			return nil, &StorageError{Message: "failed to create MinIO presign client", Err: err}
		}
	}

	return &Client{
		client:        client,
		presignClient: presignClient,
		bucket:        cfg.MinioBucket,
		endpoint:      cfg.MinIOEndpoint,
		secure:        cfg.MinIOSecure,
		region:        cfg.MinIORegion,
	}, nil
}

// parseMinIOHostAndSecure converts MINIO_EXTERNAL_ENDPOINT (URL or host:port) for minio.New.
// Path-prefixed URLs are rejected because minio.New accepts only host:port endpoints.
func parseMinIOHostAndSecure(raw string, fallbackSecure bool) (host string, secure bool, err error) {
	raw = strings.TrimSpace(raw)
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err == nil && u.Host != "" {
			if u.Scheme != "http" && u.Scheme != "https" {
				return "", false, fmt.Errorf(
					"MINIO_EXTERNAL_ENDPOINT must use http, https, or no scheme: %q",
					raw,
				)
			}
			if u.Path != "" && u.Path != "/" {
				return "", false, fmt.Errorf(
					"MINIO_EXTERNAL_ENDPOINT must not include a path prefix: %q",
					raw,
				)
			}
			return u.Host, u.Scheme == "https", nil
		}
	}
	return raw, fallbackSecure, nil
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

// buildPath builds the storage path from an object ID.
func (c *Client) buildPath(objectID string) string {
	return "objects/" + objectID
}

func (c *Client) buildVersionedPath(objectID string) string {
	return fmt.Sprintf("objects/%s/%d", objectID, time.Now().UTC().UnixNano())
}

func (c *Client) buildStagingPath(objectID string) string {
	return fmt.Sprintf("staging/objects/%s/%d", objectID, time.Now().UTC().UnixNano())
}

// NewObjectPath returns a durable unique storage path for a new object blob version.
func (c *Client) NewObjectPath(objectID string) string {
	return c.buildVersionedPath(objectID)
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

// ObjectPath returns the canonical storage path for an object ID.
func (c *Client) ObjectPath(objectID string) string {
	return c.buildPath(objectID)
}

// UploadObject uploads an object to storage.
func (c *Client) UploadObject(ctx context.Context, objectID string, data []byte, contentType string) (*ObjectInfo, error) {
	reader := bytes.NewReader(data)
	return c.putObject(ctx, objectID, c.buildPath(objectID), reader, int64(len(data)), contentType)
}

// UploadObjectFromReader uploads an object from a reader.
func (c *Client) UploadObjectFromReader(ctx context.Context, objectID string, reader io.Reader, size int64, contentType string) (*ObjectInfo, error) {
	return c.putObject(ctx, objectID, c.buildPath(objectID), reader, size, contentType)
}

// UploadObjectFromReaderToPath uploads an object to an explicit storage path.
func (c *Client) UploadObjectFromReaderToPath(ctx context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*ObjectInfo, error) {
	return c.putObject(ctx, objectID, path, reader, size, contentType)
}

// UploadObjectFromReaderStaged uploads an object to a temporary staging key.
func (c *Client) UploadObjectFromReaderStaged(ctx context.Context, objectID string, reader io.Reader, size int64, contentType string) (*ObjectInfo, error) {
	return c.putObject(ctx, objectID, c.buildStagingPath(objectID), reader, size, contentType)
}

// PromoteObjectPath copies a staged object to the canonical key and removes the staged key.
// If the copy succeeds but the staging key deletion fails, the promotion is still
// considered successful. The orphaned staging key is logged as a warning so
// operators can clean it up; returning an error here would cause the caller to
// believe the entire promotion failed even though the canonical object is ready.
func (c *Client) PromoteObjectPath(ctx context.Context, sourcePath, objectID string) error {
	destPath := c.buildPath(objectID)
	if sourcePath == "" || sourcePath == destPath {
		return nil
	}

	_, err := c.client.CopyObject(
		ctx,
		minio.CopyDestOptions{Bucket: c.bucket, Object: destPath},
		minio.CopySrcOptions{Bucket: c.bucket, Object: sourcePath},
	)
	if err != nil {
		code := minio.ToErrorResponse(err).Code
		if code == "NoSuchBucket" {
			return &BucketNotFoundError{Bucket: c.bucket}
		}
		return &StorageError{Message: "failed to promote staged object", Err: err}
	}

	if err := c.DeleteObjectPath(ctx, sourcePath); err != nil {
		// Copy succeeded but staging cleanup failed. Log for operator attention
		// and continue; the canonical object is in place.
		log.Warn().
			Err(err).
			Str("source_path", sourcePath).
			Str("object_id", objectID).
			Str("bucket", c.bucket).
			Msg("PromoteObjectPath: staging key deletion failed; orphaned staging file left behind")
	}
	return nil
}

// DownloadObject downloads an object from storage.
func (c *Client) DownloadObject(ctx context.Context, objectID string) ([]byte, error) {
	path := c.buildPath(objectID)

	obj, err := c.client.GetObject(ctx, c.bucket, path, minio.GetObjectOptions{})
	if err != nil {
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchBucket":
			return nil, &BucketNotFoundError{Bucket: c.bucket}
		case "NoSuchKey":
			return nil, &ObjectNotFoundError{Bucket: c.bucket, ObjectName: path}
		default:
			return nil, &StorageError{Message: "failed to get object", Err: err}
		}
	}
	defer func() { _ = obj.Close() }()

	data, err := io.ReadAll(obj)
	if err != nil {
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchBucket":
			return nil, &BucketNotFoundError{Bucket: c.bucket}
		case "NoSuchKey":
			return nil, &ObjectNotFoundError{Bucket: c.bucket, ObjectName: path}
		default:
			return nil, &StorageError{Message: "failed to read object", Err: err}
		}
	}

	return data, nil
}

// StreamObject returns an io.ReadCloser for streaming an object.
func (c *Client) StreamObject(ctx context.Context, objectID string) (io.ReadCloser, *ObjectInfo, error) {
	return c.StreamObjectPath(ctx, objectID, c.buildPath(objectID))
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

// DeleteObject deletes an object from storage.
func (c *Client) DeleteObject(ctx context.Context, objectID string) error {
	return c.DeleteObjectPath(ctx, c.buildPath(objectID))
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

// ObjectExists checks if an object exists in storage.
func (c *Client) ObjectExists(ctx context.Context, objectID string) (bool, error) {
	path := c.buildPath(objectID)
	_, err := c.client.StatObject(ctx, c.bucket, path, minio.StatObjectOptions{})
	if err != nil {
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchKey":
			return false, nil
		case "NoSuchBucket":
			return false, &BucketNotFoundError{Bucket: c.bucket}
		default:
			return false, &StorageError{Message: "failed to check object existence", Err: err}
		}
	}
	return true, nil
}

// GetObjectInfo returns information about an object.
func (c *Client) GetObjectInfo(ctx context.Context, objectID string) (*ObjectInfo, error) {
	path := c.buildPath(objectID)
	stat, err := c.client.StatObject(ctx, c.bucket, path, minio.StatObjectOptions{})
	if err != nil {
		switch minio.ToErrorResponse(err).Code {
		case "NoSuchBucket":
			return nil, &BucketNotFoundError{Bucket: c.bucket}
		case "NoSuchKey":
			return nil, &ObjectNotFoundError{Bucket: c.bucket, ObjectName: path}
		default:
			return nil, &StorageError{Message: "failed to get object info", Err: err}
		}
	}

	return &ObjectInfo{
		ObjectID:     objectID,
		Bucket:       c.bucket,
		Path:         path,
		SizeBytes:    stat.Size,
		ContentType:  stat.ContentType,
		ETag:         stat.ETag,
		LastModified: stat.LastModified,
	}, nil
}

// GetPresignedURL generates a presigned URL for downloading an object.
func (c *Client) GetPresignedURL(ctx context.Context, objectID string, expires time.Duration) (string, error) {
	path := c.buildPath(objectID)

	presignedURL, err := c.presignClient.PresignedGetObject(ctx, c.bucket, path, expires, url.Values{})
	if err != nil {
		return "", &StorageError{Message: "failed to generate presigned URL", Err: err}
	}

	return presignedURL.String(), nil
}

// GetPresignedUploadURL generates a presigned URL for uploading an object.
func (c *Client) GetPresignedUploadURL(ctx context.Context, objectID string, expires time.Duration) (string, error) {
	path := c.buildPath(objectID)

	presignedURL, err := c.presignClient.PresignedPutObject(ctx, c.bucket, path, expires)
	if err != nil {
		return "", &StorageError{Message: "failed to generate presigned upload URL", Err: err}
	}

	return presignedURL.String(), nil
}
