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

func TestNewClientRejectsNilConfig(t *testing.T) {
	client, err := NewClient(nil)
	if err == nil || client != nil {
		t.Fatalf("NewClient(nil) = (%#v, %v), want nil client and error", client, err)
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

func TestNewClientRejectsWhitespaceSecretKey(t *testing.T) {
	cfg := &config.Config{
		MinIOEndpoint:  "localhost:9000",
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "   ",
		MinioBucket:    "atlas-media",
	}

	client, err := NewClient(cfg)
	if err == nil {
		t.Fatalf("expected whitespace secret key to fail, got client %#v", client)
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
		MinIOEndpoint:  "localhost:9000",
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "secret123",
		MinioBucket:    "atlas-media",
		MinIOSecure:    true,
		MinIORegion:    "us-east-1",
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
	if !client.secure {
		t.Fatal("expected secure client configuration to be preserved")
	}
}

func TestNewObjectPathUsesVersionedKey(t *testing.T) {
	client := &Client{}
	objectID := "test-object"
	got := client.NewObjectPath(objectID)
	prefix := "objects/" + objectID + "/"
	if !strings.HasPrefix(got, prefix) {
		t.Fatalf("NewObjectPath(%q) = %q, want prefix %q", objectID, got, prefix)
	}
	if got == "objects/"+objectID {
		t.Fatalf("NewObjectPath(%q) returned stale canonical key %q", objectID, got)
	}
}

func TestBucketAccessor(t *testing.T) {
	client := &Client{bucket: "atlas-media"}
	if got := client.Bucket(); got != "atlas-media" {
		t.Fatalf("Bucket() = %q, want atlas-media", got)
	}
}
