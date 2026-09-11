package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
)

type managedKeyServiceStub struct {
	createdName string
	createdBy   string
	keys        []admin.APIKeyMetadata
	revokeID    string
	createErr   error
	listErr     error
	revokeErr   error
}

func (s *managedKeyServiceStub) CreateAPIKey(_ context.Context, name, createdBy string, _ time.Time) (admin.CreatedAPIKey, error) {
	s.createdName = name
	s.createdBy = createdBy
	if s.createErr != nil {
		return admin.CreatedAPIKey{}, s.createErr
	}
	return admin.CreatedAPIKey{
		APIKeyMetadata: admin.APIKeyMetadata{
			ID:        "atlas_ak_0123456789abcdef",
			Name:      name,
			KeyPrefix: "atlas_ak_0123456789abcdef",
			CreatedBy: createdBy,
		},
		APIKey: "atlas_ak_0123456789abcdef.secret",
	}, nil
}

func (s *managedKeyServiceStub) ListAPIKeys(context.Context) ([]admin.APIKeyMetadata, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.keys, nil
}

func (s *managedKeyServiceStub) RevokeAPIKey(_ context.Context, keyID string, _ time.Time) error {
	s.revokeID = keyID
	return s.revokeErr
}

func TestDispatchManagedKeysCreateWritesOneTimeKeyJSON(t *testing.T) {
	service := &managedKeyServiceStub{}
	var stdout bytes.Buffer

	if err := dispatchManagedKeys([]string{"create", "plugin root"}, service, &stdout); err != nil {
		t.Fatalf("dispatch create: %v", err)
	}
	if service.createdName != "plugin root" || service.createdBy != managedKeyCreatedBy {
		t.Fatalf("CreateAPIKey arguments = (%q, %q), want name and %q", service.createdName, service.createdBy, managedKeyCreatedBy)
	}
	var response admin.CreatedAPIKey
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if response.APIKey != "atlas_ak_0123456789abcdef.secret" {
		t.Fatalf("create response api_key = %q", response.APIKey)
	}
}

func TestDispatchManagedKeysListMatchesNameExactly(t *testing.T) {
	service := &managedKeyServiceStub{keys: []admin.APIKeyMetadata{
		{ID: "atlas_ak_0123456789abcdef", Name: "plugin root"},
		{ID: "atlas_ak_aaaaaaaaaaaaaaaa", Name: "Plugin root"},
		{ID: "atlas_ak_bbbbbbbbbbbbbbbb", Name: "plugin root"},
	}}
	var stdout bytes.Buffer

	if err := dispatchManagedKeys([]string{"list", "plugin root"}, service, &stdout); err != nil {
		t.Fatalf("dispatch list: %v", err)
	}
	var response []admin.APIKeyMetadata
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(response) != 2 || response[0].ID != service.keys[0].ID || response[1].ID != service.keys[2].ID {
		t.Fatalf("list response = %#v, want exact-name matches", response)
	}
}

func TestDispatchManagedKeysRevokeIsIdempotent(t *testing.T) {
	keyID := "atlas_ak_0123456789abcdef"
	for _, test := range []struct {
		name      string
		err       error
		wantState bool
	}{
		{name: "revoked", wantState: true},
		{name: "absent", err: admin.ErrAPIKeyNotFound, wantState: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &managedKeyServiceStub{revokeErr: test.err}
			var stdout bytes.Buffer
			if err := dispatchManagedKeys([]string{"revoke", keyID}, service, &stdout); err != nil {
				t.Fatalf("dispatch revoke: %v", err)
			}
			if service.revokeID != keyID {
				t.Fatalf("RevokeAPIKey id = %q, want %q", service.revokeID, keyID)
			}
			var response managedKeyRevokeResult
			if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
				t.Fatalf("decode revoke response: %v", err)
			}
			if response.ID != keyID || response.Revoked != test.wantState {
				t.Fatalf("revoke response = %#v, want id and revoked=%t", response, test.wantState)
			}
		})
	}
}

func TestDispatchManagedKeysRejectsInvalidArguments(t *testing.T) {
	service := &managedKeyServiceStub{}
	tests := []struct {
		name string
		args []string
	}{
		{name: "missing operation", args: nil},
		{name: "extra argument", args: []string{"list", "plugin root", "extra"}},
		{name: "unknown operation", args: []string{"delete", "plugin root"}},
		{name: "empty name", args: []string{"list", "   "}},
		{name: "long name", args: []string{"create", string(bytes.Repeat([]byte{'x'}, managedKeyNameMaxRunes+1))}},
		{name: "invalid key id", args: []string{"revoke", "atlas_ak_short"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout bytes.Buffer
			if err := dispatchManagedKeys(test.args, service, &stdout); err == nil {
				t.Fatal("expected argument validation error")
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q, want empty on failure", stdout.String())
			}
		})
	}
}

func TestDispatchManagedKeysPropagatesServiceErrors(t *testing.T) {
	wantErr := errors.New("database unavailable")
	for _, test := range []struct {
		name string
		args []string
		stub managedKeyServiceStub
	}{
		{name: "create", args: []string{"create", "plugin root"}, stub: managedKeyServiceStub{createErr: wantErr}},
		{name: "list", args: []string{"list", "plugin root"}, stub: managedKeyServiceStub{listErr: wantErr}},
		{name: "revoke", args: []string{"revoke", "atlas_ak_0123456789abcdef"}, stub: managedKeyServiceStub{revokeErr: wantErr}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout bytes.Buffer
			err := dispatchManagedKeys(test.args, &test.stub, &stdout)
			if !errors.Is(err, wantErr) {
				t.Fatalf("error = %v, want wrapped service error", err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q, want empty on failure", stdout.String())
			}
		})
	}
}
