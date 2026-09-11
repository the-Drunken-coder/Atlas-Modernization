package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/database"
)

const (
	managedKeysCommand     = "managed-keys"
	managedKeyCreatedBy    = "host-manager"
	managedKeyNameMaxRunes = 120
	managedKeyIDPrefix     = "atlas_ak_"
	managedKeyIDLength     = len(managedKeyIDPrefix) + 16
)

// managedKeyService is the small part of admin.Service needed by the
// host-only managed-key command. Keeping the command against this interface
// makes its argument and output contract testable without a database.
type managedKeyService interface {
	CreateAPIKey(context.Context, string, string, time.Time) (admin.CreatedAPIKey, error)
	ListAPIKeys(context.Context) ([]admin.APIKeyMetadata, error)
	RevokeAPIKey(context.Context, string, time.Time) error
}

// runManagedKeysCommand opens an already initialized database and dispatches
// one managed-key operation. It deliberately does not run migrations, seed
// admin data, or touch object storage.
func runManagedKeysCommand(args []string, cfg *config.Config, stdout io.Writer) error {
	if err := validateManagedKeysArgs(args); err != nil {
		return err
	}
	db, err := database.New(cfg)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer db.Close()

	return dispatchManagedKeys(args, admin.NewService(db.Pool, cfg), stdout)
}

// dispatchManagedKeys executes the already parsed managed-key operation and
// writes exactly one JSON value to stdout on success. Diagnostics belong to
// the caller so this function can be used by tests and other command hosts.
func dispatchManagedKeys(args []string, service managedKeyService, stdout io.Writer) error {
	if err := validateManagedKeysArgs(args); err != nil {
		return err
	}
	if service == nil {
		return errors.New("managed-key service is unavailable")
	}
	if stdout == nil {
		return errors.New("managed-key output is unavailable")
	}

	ctx := context.Background()
	switch args[0] {
	case "create":
		created, err := service.CreateAPIKey(ctx, args[1], managedKeyCreatedBy, time.Now().UTC())
		if err != nil {
			return fmt.Errorf("create managed API key: %w", err)
		}
		return encodeManagedKeyJSON(stdout, created)
	case "list":
		keys, err := service.ListAPIKeys(ctx)
		if err != nil {
			return fmt.Errorf("list managed API keys: %w", err)
		}
		matches := make([]admin.APIKeyMetadata, 0, len(keys))
		for _, key := range keys {
			if key.Name == args[1] {
				matches = append(matches, key)
			}
		}
		return encodeManagedKeyJSON(stdout, matches)
	case "revoke":
		err := service.RevokeAPIKey(ctx, args[1], time.Now().UTC())
		revoked := err == nil
		if err != nil && !errors.Is(err, admin.ErrAPIKeyNotFound) {
			return fmt.Errorf("revoke managed API key: %w", err)
		}
		return encodeManagedKeyJSON(stdout, managedKeyRevokeResult{ID: args[1], Revoked: revoked})
	default:
		// validateManagedKeysArgs handles this branch; keep the switch total if
		// another caller changes validation in the future.
		return managedKeysUsageError()
	}
}

type managedKeyRevokeResult struct {
	ID      string `json:"id"`
	Revoked bool   `json:"revoked"`
}

func encodeManagedKeyJSON(stdout io.Writer, value any) error {
	if err := json.NewEncoder(stdout).Encode(value); err != nil {
		return fmt.Errorf("write managed-key JSON: %w", err)
	}
	return nil
}

func validateManagedKeysArgs(args []string) error {
	if len(args) != 2 {
		return managedKeysUsageError()
	}
	switch args[0] {
	case "create", "list":
		if err := validateManagedKeyName(args[1]); err != nil {
			return err
		}
	case "revoke":
		if err := validateManagedKeyID(args[1]); err != nil {
			return err
		}
	default:
		return managedKeysUsageError()
	}
	return nil
}

func managedKeysUsageError() error {
	return errors.New("usage: atlas_core managed-keys create <name> | list <name> | revoke <key_id>")
}

func validateManagedKeyName(name string) error {
	if strings.TrimSpace(name) == "" {
		return admin.ErrAPIKeyNameRequired
	}
	if len([]rune(name)) > managedKeyNameMaxRunes {
		return admin.ErrAPIKeyNameTooLong
	}
	return nil
}

func validateManagedKeyID(keyID string) error {
	if len(keyID) != managedKeyIDLength || !strings.HasPrefix(keyID, managedKeyIDPrefix) {
		return errors.New("managed API key id must be a generated atlas_ak_ id")
	}
	for _, char := range keyID[len(managedKeyIDPrefix):] {
		if !isManagedKeyIDCharacter(char) {
			return errors.New("managed API key id must be a generated atlas_ak_ id")
		}
	}
	return nil
}

func isManagedKeyIDCharacter(char rune) bool {
	return char >= 'a' && char <= 'z' ||
		char >= 'A' && char <= 'Z' ||
		char >= '0' && char <= '9' ||
		char == '_' || char == '-'
}
