package storage

import (
	"errors"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestStorageErrorMessage(t *testing.T) {
	err := &StorageError{Message: "test error"}
	if err.Error() != "test error" {
		t.Fatalf("expected plain storage error message, got %q", err.Error())
	}
}

func TestStorageErrorWithWrapped(t *testing.T) {
	innerErr := &StorageError{Message: "inner error"}
	outerErr := &StorageError{Message: "outer error", Err: innerErr}

	if got := outerErr.Error(); got != "outer error: inner error" {
		t.Fatalf("expected wrapped error message, got %q", got)
	}
}

func TestStorageErrorUnwrap(t *testing.T) {
	innerErr := &StorageError{Message: "inner error"}
	outerErr := &StorageError{Message: "outer error", Err: innerErr}

	if !errors.Is(outerErr, innerErr) {
		t.Fatalf("expected outer error to wrap inner error")
	}
}

func TestObjectNotFoundError(t *testing.T) {
	err := &ObjectNotFoundError{Bucket: "atlas-media", ObjectName: "test-object"}
	got := err.Error()
	if !strings.Contains(got, "object not found") || !strings.Contains(got, "atlas-media") || !strings.Contains(got, "test-object") {
		t.Fatalf("unexpected object not found message: %q", got)
	}
}

func TestBucketNotFoundError(t *testing.T) {
	err := &BucketNotFoundError{Bucket: "missing-bucket"}
	got := err.Error()
	if !strings.Contains(got, "bucket not found") || !strings.Contains(got, "missing-bucket") {
		t.Fatalf("unexpected bucket not found message: %q", got)
	}
}

func TestNewClientRequiresAccessKey(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:  "localhost:9000",
		MinIOSecretKey: "secret",
		MinioBucket:    "atlas-media",
	}

	client, err := NewClient(cfg)
	if err == nil {
		t.Fatalf("expected missing access key to fail, got client %#v", client)
	}
	storageErr, ok := err.(*StorageError)
	if !ok {
		t.Fatalf("expected StorageError, got %T", err)
	}
	if !strings.Contains(storageErr.Message, "MinIO access key not configured") {
		t.Fatalf("unexpected error message: %q", storageErr.Message)
	}
}

func TestNewClientRequiresSecretKey(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:  "localhost:9000",
		MinIOAccessKey: "atlas",
		MinioBucket:    "atlas-media",
	}

	client, err := NewClient(cfg)
	if err == nil {
		t.Fatalf("expected missing secret key to fail, got client %#v", client)
	}

	storageErr, ok := err.(*StorageError)
	if !ok {
		t.Fatalf("expected StorageError, got %T", err)
	}
	if !strings.Contains(storageErr.Message, "MinIO secret key not configured") {
		t.Fatalf("unexpected error message: %q", storageErr.Message)
	}
}

func TestNewClientRequiresEndpoint(t *testing.T) {
	cfg := &config.Config{
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "secret",
		MinioBucket:    "atlas-media",
	}

	client, err := NewClient(cfg)
	if err == nil {
		t.Fatalf("expected missing endpoint to fail, got client %#v", client)
	}
	storageErr, ok := err.(*StorageError)
	if !ok {
		t.Fatalf("expected StorageError, got %T", err)
	}
	if !strings.Contains(storageErr.Message, "MinIO endpoint not configured") {
		t.Fatalf("unexpected error message: %q", storageErr.Message)
	}
}

func TestNewClientRequiresBucket(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:  "localhost:9000",
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "secret",
	}

	client, err := NewClient(cfg)
	if err == nil {
		t.Fatalf("expected missing bucket to fail, got client %#v", client)
	}
	storageErr, ok := err.(*StorageError)
	if !ok {
		t.Fatalf("expected StorageError, got %T", err)
	}
	if !strings.Contains(storageErr.Message, "MinIO bucket not configured") {
		t.Fatalf("unexpected error message: %q", storageErr.Message)
	}
}

func TestNewClientUsesConfiguredEndpoints(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:         "localhost:9000",
		MinIOExternalEndpoint: "cdn.example.com",
		MinIOAccessKey:        "atlas",
		MinIOSecretKey:        "secret123",
		MinioBucket:           "atlas-media",
		MinIOSecure:           true,
		MinIORegion:           "us-east-1",
	}

	client, err := NewClient(cfg)
	if err != nil {
		t.Fatalf("expected NewClient to succeed, got %v", err)
	}

	if client.bucket != cfg.MinioBucket {
		t.Fatalf("expected bucket %q, got %q", cfg.MinioBucket, client.bucket)
	}
	if client.endpoint != cfg.MinIOEndpoint {
		t.Fatalf("expected endpoint %q, got %q", cfg.MinIOEndpoint, client.endpoint)
	}
	if client.presignClient == client.client {
		t.Fatal("expected separate presign MinIO client when external endpoint differs from internal")
	}
	if !client.secure {
		t.Fatal("expected secure client configuration to be preserved")
	}
}

func TestNewClientDefaultsExternalEndpointToInternal(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:  "localhost:9000",
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "secret123",
		MinioBucket:    "atlas-media",
	}

	client, err := NewClient(cfg)
	if err != nil {
		t.Fatalf("expected NewClient to succeed, got %v", err)
	}

	if client.presignClient != client.client {
		t.Fatal("expected presign client to match main client when external endpoint is unset")
	}
}

func TestParseMinIOHostAndSecure(t *testing.T) {
	tests := []struct {
		name           string
		raw            string
		fallbackSecure bool
		wantHost       string
		wantSecure     bool
		wantErr        string
	}{
		{
			name:           "plain host uses fallback secure",
			raw:            "cdn.example.com:9000",
			fallbackSecure: true,
			wantHost:       "cdn.example.com:9000",
			wantSecure:     true,
		},
		{
			name:       "https url",
			raw:        "https://cdn.example.com",
			wantHost:   "cdn.example.com",
			wantSecure: true,
		},
		{
			name:       "http url",
			raw:        "http://cdn.example.com:9000",
			wantHost:   "cdn.example.com:9000",
			wantSecure: false,
		},
		{
			name:    "reject unsupported scheme",
			raw:     "ftp://cdn.example.com",
			wantErr: "http, https, or no scheme",
		},
		{
			name:    "reject path prefix",
			raw:     "https://cdn.example.com/minio",
			wantErr: "must not include a path prefix",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host, secure, err := parseMinIOHostAndSecure(tt.raw, tt.fallbackSecure)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %v", tt.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if host != tt.wantHost || secure != tt.wantSecure {
				t.Fatalf("got (%q, %v), want (%q, %v)", host, secure, tt.wantHost, tt.wantSecure)
			}
		})
	}
}

func TestBuildPath(t *testing.T) {
	client := &Client{}

	tests := map[string]string{
		"test-object":      "objects/test-object",
		"abc123":           "objects/abc123",
		"uuid-with-dashes": "objects/uuid-with-dashes",
	}

	for objectID, want := range tests {
		if got := client.buildPath(objectID); got != want {
			t.Fatalf("buildPath(%q) = %q, want %q", objectID, got, want)
		}
	}
}

func TestBucketAccessor(t *testing.T) {
	client := &Client{bucket: "atlas-media"}
	if got := client.Bucket(); got != "atlas-media" {
		t.Fatalf("Bucket() = %q, want atlas-media", got)
	}
}
