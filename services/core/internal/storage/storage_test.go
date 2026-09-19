package storage

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/services/core/internal/config"
)

func TestStorageErrorUnwrap(t *testing.T) {
	innerErr := &StorageError{Message: "inner error"}
	outerErr := &StorageError{Message: "outer error", Err: innerErr}

	if !errors.Is(outerErr, innerErr) {
		t.Fatalf("expected outer error to wrap inner error")
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

func TestExplicitObjectOperationsRequireBucket(t *testing.T) {
	client := &Client{}
	if _, _, err := client.StreamObjectPath(context.Background(), "object-1", "  ", "path"); err == nil || err.Error() != "storage bucket not configured" {
		t.Fatalf("StreamObjectPath empty bucket error = %v", err)
	}
	if err := client.DeleteObjectPath(context.Background(), "  ", "path"); err == nil || err.Error() != "storage bucket not configured" {
		t.Fatalf("DeleteObjectPath empty bucket error = %v", err)
	}
}
