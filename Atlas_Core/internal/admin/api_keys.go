package admin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	apiKeyIDPrefix       = "atlas_ak_"
	apiKeyRecordPrefix   = "api_key:"
	apiKeyNameMaxRunes   = 120
	apiKeyIDRandomBytes  = 12
	apiKeySecretBytes    = 32
	apiKeyInsertAttempts = 5
)

var (
	ErrAPIKeyNameRequired = errors.New("api key name is required")
	ErrAPIKeyNameTooLong  = errors.New("api key name is too long")
	ErrAPIKeyNotFound     = errors.New("api key not found")
)

type APIKeyRecord struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	KeyPrefix  string     `json:"key_prefix"`
	SecretHash string     `json:"secret_hash"`
	CreatedAt  time.Time  `json:"created_at"`
	CreatedBy  string     `json:"created_by"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type APIKeyMetadata struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	KeyPrefix string    `json:"key_prefix"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by"`
}

type CreatedAPIKey struct {
	APIKeyMetadata
	APIKey string `json:"api_key"`
}

func (s *Service) CreateAPIKey(ctx context.Context, name, createdBy string, now time.Time) (CreatedAPIKey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return CreatedAPIKey{}, ErrAPIKeyNameRequired
	}
	if len([]rune(name)) > apiKeyNameMaxRunes {
		return CreatedAPIKey{}, ErrAPIKeyNameTooLong
	}
	createdBy = strings.TrimSpace(createdBy)
	if createdBy == "" {
		createdBy = "admin"
	}
	now = now.UTC()

	for attempt := 0; attempt < apiKeyInsertAttempts; attempt++ {
		keyID, err := randomAPIKeyID()
		if err != nil {
			return CreatedAPIKey{}, err
		}
		secret, err := randomAPIKeySecret()
		if err != nil {
			return CreatedAPIKey{}, err
		}
		record := APIKeyRecord{
			ID:         keyID,
			Name:       name,
			KeyPrefix:  keyID,
			SecretHash: hashAPIKeySecret(secret),
			CreatedAt:  now,
			CreatedBy:  createdBy,
		}
		payload, err := json.Marshal(record)
		if err != nil {
			return CreatedAPIKey{}, err
		}
		tag, err := s.pool.Exec(ctx, `
			INSERT INTO admin_records (id, type, json)
			VALUES ($1, 'api_key', $2)
			ON CONFLICT (id) DO NOTHING
		`, apiKeyRecordID(keyID), payload)
		if err != nil {
			return CreatedAPIKey{}, err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		metadata := apiKeyMetadata(record)
		return CreatedAPIKey{APIKeyMetadata: metadata, APIKey: keyID + "." + secret}, nil
	}
	return CreatedAPIKey{}, fmt.Errorf("generate unique api key id")
}

func (s *Service) ListAPIKeys(ctx context.Context) ([]APIKeyMetadata, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT json
		FROM admin_records
		WHERE type = 'api_key'
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	keys := []APIKeyMetadata{}
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var record APIKeyRecord
		if err := json.Unmarshal(payload, &record); err != nil {
			return nil, err
		}
		if record.RevokedAt != nil {
			continue
		}
		keys = append(keys, apiKeyMetadata(record))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return keys, nil
}

func (s *Service) RevokeAPIKey(ctx context.Context, keyID string, now time.Time) error {
	record, err := s.getAPIKeyRecord(ctx, keyID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAPIKeyNotFound
		}
		return err
	}
	if record.RevokedAt != nil {
		return ErrAPIKeyNotFound
	}
	revokedAt := now.UTC()
	record.RevokedAt = &revokedAt
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE admin_records
		SET json = $2, updated_at = clock_timestamp()
		WHERE id = $1 AND type = 'api_key'
	`, apiKeyRecordID(keyID), payload)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAPIKeyNotFound
	}
	return nil
}

func (s *Service) AuthenticateAPIKey(ctx context.Context, apiKey string) bool {
	ok, err := s.AuthenticateAPIKeyResult(ctx, apiKey)
	return err == nil && ok
}

func (s *Service) AuthenticateAPIKeyResult(ctx context.Context, apiKey string) (bool, error) {
	keyID, secret, ok := parseManagedAPIKey(apiKey)
	if !ok {
		return false, nil
	}
	record, err := s.getAPIKeyRecord(ctx, keyID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if record.RevokedAt != nil {
		return false, nil
	}
	actual := hashAPIKeySecret(secret)
	return subtle.ConstantTimeCompare([]byte(actual), []byte(record.SecretHash)) == 1, nil
}

func (s *Service) getAPIKeyRecord(ctx context.Context, keyID string) (APIKeyRecord, error) {
	var record APIKeyRecord
	keyID = strings.TrimSpace(keyID)
	if !strings.HasPrefix(keyID, apiKeyIDPrefix) {
		return record, pgx.ErrNoRows
	}
	var payload []byte
	err := s.pool.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'api_key'`, apiKeyRecordID(keyID)).Scan(&payload)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(payload, &record)
	return record, err
}

func apiKeyMetadata(record APIKeyRecord) APIKeyMetadata {
	return APIKeyMetadata{
		ID:        record.ID,
		Name:      record.Name,
		KeyPrefix: record.KeyPrefix,
		CreatedAt: record.CreatedAt,
		CreatedBy: record.CreatedBy,
	}
}

func randomAPIKeyID() (string, error) {
	buf := make([]byte, apiKeyIDRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return apiKeyIDPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func randomAPIKeySecret() (string, error) {
	buf := make([]byte, apiKeySecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func parseManagedAPIKey(apiKey string) (string, string, bool) {
	apiKey = strings.TrimSpace(apiKey)
	keyID, secret, ok := strings.Cut(apiKey, ".")
	if !ok || !strings.HasPrefix(keyID, apiKeyIDPrefix) || strings.TrimSpace(secret) == "" {
		return "", "", false
	}
	return keyID, secret, true
}

func apiKeyRecordID(keyID string) string {
	return apiKeyRecordPrefix + keyID
}

func hashAPIKeySecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}
