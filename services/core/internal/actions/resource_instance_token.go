package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ResourceInstanceTokenHeader carries a caller-generated capability for
// identifying one Entity or Object instance across a lost create response.
const ResourceInstanceTokenHeader = "Atlas-Resource-Instance-Token"

const maxResourceInstanceTokenBytes = 256

// ValidateResourceInstanceToken checks the opaque token before it is accepted
// from an HTTP header or an internal action caller.
func ValidateResourceInstanceToken(token string) error {
	if token == "" {
		return fmt.Errorf("resource instance token must not be empty")
	}
	if len(token) > maxResourceInstanceTokenBytes {
		return fmt.Errorf("resource instance token must be at most %d bytes", maxResourceInstanceTokenBytes)
	}
	if token != strings.TrimSpace(token) {
		return fmt.Errorf("resource instance token must not have surrounding whitespace")
	}
	for _, character := range token {
		if character < 0x20 || character == 0x7f {
			return fmt.Errorf("resource instance token contains a control character")
		}
	}
	return nil
}

func resourceInstanceTokenHash(token string) (string, error) {
	if err := ValidateResourceInstanceToken(token); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:]), nil
}

func reserveResourceInstanceToken(ctx context.Context, tx pgx.Tx, tokenHash string) error {
	result, err := tx.Exec(ctx, `
		INSERT INTO resource_instance_tokens (token_hash)
		VALUES ($1)
		ON CONFLICT (token_hash) DO NOTHING
	`, tokenHash)
	if err != nil {
		return fmt.Errorf("failed to reserve resource instance token: %w", err)
	}
	if result.RowsAffected() == 0 {
		return NewValidationError("resource instance token has already been used")
	}
	return nil
}

func checkResourceInstanceToken(expectedToken *string, storedHash *string, resourceType string) error {
	if expectedToken == nil {
		return nil
	}
	hash, err := resourceInstanceTokenHash(*expectedToken)
	if err != nil {
		return NewValidationError(err.Error())
	}
	if storedHash == nil || *storedHash != hash {
		return NewResourceInstanceTokenPreconditionFailedError(resourceType)
	}
	return nil
}
