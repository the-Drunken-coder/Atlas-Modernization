// Package admin owns Atlas Core browser account and session authentication.
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
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"golang.org/x/crypto/argon2"
)

const (
	CookieName    = "atlas_session"
	defaultUser   = "admin"
	defaultRole   = "admin"
	defaultPass   = "password"
	sessionTTL    = 7 * 24 * time.Hour
	loginWindow   = 15 * time.Minute
	loginMaxFails = 8

	maxArgon2HashLength = 1<<32 - 1
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrTooManyAttempts    = errors.New("too many login attempts")
	ErrInvalidSession     = errors.New("invalid session")
)

type PasswordHash struct {
	Algorithm   string `json:"algorithm"`
	MemoryKiB   uint32 `json:"memory_kib"`
	Time        uint32 `json:"time"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
	Hash        string `json:"hash"`
}

type AccountRecord struct {
	Username string       `json:"username"`
	Password PasswordHash `json:"password"`
	Role     string       `json:"role"`
	Disabled bool         `json:"disabled"`
}

type SessionRecord struct {
	AccountID string    `json:"account_id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type LoginFailureRecord struct {
	Count   int       `json:"count"`
	ResetAt time.Time `json:"reset_at"`
}

type AuthenticatedSession struct {
	AccountID string
	Username  string
	Role      string
	ExpiresAt time.Time
}

type Service struct {
	pool           *pgxpool.Pool
	cookieSameSite http.SameSite
}

func NewService(pool *pgxpool.Pool, cfg *config.Config) *Service {
	return &Service{pool: pool, cookieSameSite: sameSiteMode(cfg)}
}

func (s *Service) SeedDevelopmentAdmin(ctx context.Context) error {
	password, err := developmentPassword()
	if err != nil {
		return err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return s.createAccountIfMissing(ctx, "account:"+defaultUser, AccountRecord{
		Username: defaultUser,
		Password: hash,
		Role:     defaultRole,
		Disabled: false,
	})
}

func (s *Service) createAccountIfMissing(ctx context.Context, id string, account AccountRecord) error {
	payload, err := json.Marshal(account)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'account', $2)
		ON CONFLICT (id) DO NOTHING
	`, id, payload)
	return err
}

func (s *Service) GetAccount(ctx context.Context, id string) (AccountRecord, error) {
	var account AccountRecord
	var payload []byte
	err := s.pool.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'account'`, id).Scan(&payload)
	if err != nil {
		return account, err
	}
	err = json.Unmarshal(payload, &account)
	return account, err
}

func (s *Service) Login(ctx context.Context, username, password, ip string, now time.Time) (string, SessionRecord, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return "", SessionRecord{}, ErrInvalidCredentials
	}
	if throttled, err := s.loginThrottled(ctx, username, ip, now); err != nil {
		return "", SessionRecord{}, err
	} else if throttled {
		return "", SessionRecord{}, ErrTooManyAttempts
	}

	accountID := "account:" + username
	account, err := s.GetAccount(ctx, accountID)
	if err != nil || account.Disabled || !VerifyPassword(password, account.Password) {
		_ = s.recordLoginFailure(ctx, username, ip, now)
		return "", SessionRecord{}, ErrInvalidCredentials
	}
	_ = s.clearLoginFailures(ctx, username, ip)

	token, err := randomToken()
	if err != nil {
		return "", SessionRecord{}, err
	}
	session := SessionRecord{
		AccountID: accountID,
		Username:  account.Username,
		Role:      account.Role,
		CreatedAt: now.UTC(),
		ExpiresAt: now.Add(sessionTTL).UTC(),
	}
	if err := s.storeSession(ctx, token, session); err != nil {
		return "", SessionRecord{}, err
	}
	return token, session, nil
}

func (s *Service) AuthenticateRequest(ctx context.Context, r *http.Request) (AuthenticatedSession, error) {
	cookie, err := r.Cookie(CookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	session, err := s.getSession(ctx, cookie.Value)
	if err != nil {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	if !session.ExpiresAt.After(time.Now().UTC()) {
		_ = s.deleteSession(ctx, cookie.Value)
		return AuthenticatedSession{}, ErrInvalidSession
	}
	account, err := s.GetAccount(ctx, session.AccountID)
	if err != nil || account.Disabled {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	return AuthenticatedSession{
		AccountID: session.AccountID,
		Username:  session.Username,
		Role:      session.Role,
		ExpiresAt: session.ExpiresAt,
	}, nil
}

func (s *Service) SetSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	//nolint:gosec // Cookie is explicitly HttpOnly, Secure, and SameSite-configured.
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   true,
		SameSite: s.cookieSameSite,
	})
}

func (s *Service) ClearSessionCookie(w http.ResponseWriter) {
	//nolint:gosec // Clearing cookie preserves HttpOnly, Secure, and SameSite attributes.
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: s.cookieSameSite,
	})
}

func (s *Service) Logout(ctx context.Context, r *http.Request) error {
	cookie, ok := requestSessionCookie(r)
	if !ok {
		return nil
	}
	return s.deleteSession(ctx, cookie.Value)
}

func requestSessionCookie(r *http.Request) (*http.Cookie, bool) {
	cookie, err := r.Cookie(CookieName)
	return cookie, err == nil
}

func (s *Service) storeSession(ctx context.Context, token string, session SessionRecord) error {
	payload, err := json.Marshal(session)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'session', $2)
		ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated_at = clock_timestamp()
	`, sessionID(token), payload)
	return err
}

func (s *Service) getSession(ctx context.Context, token string) (SessionRecord, error) {
	var session SessionRecord
	var payload []byte
	err := s.pool.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'session'`, sessionID(token)).Scan(&payload)
	if err != nil {
		return session, err
	}
	err = json.Unmarshal(payload, &session)
	return session, err
}

func (s *Service) deleteSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM admin_records WHERE id = $1 AND type = 'session'`, sessionID(token))
	return err
}

func (s *Service) loginThrottled(ctx context.Context, username, ip string, now time.Time) (bool, error) {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	for _, key := range keys {
		record, err := s.getLoginFailure(ctx, key)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		if err == nil && record.Count >= loginMaxFails && record.ResetAt.After(now.UTC()) {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) recordLoginFailure(ctx context.Context, username, ip string, now time.Time) error {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	for _, key := range keys {
		if err := s.upsertLoginFailure(ctx, key, now.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) clearLoginFailures(ctx context.Context, username, ip string) error {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM admin_records WHERE id = ANY($1::text[]) AND type = 'login_fail'`, keys)
	return err
}

func (s *Service) getLoginFailure(ctx context.Context, key string) (LoginFailureRecord, error) {
	var record LoginFailureRecord
	var payload []byte
	err := s.pool.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'login_fail'`, key).Scan(&payload)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(payload, &record)
	return record, err
}

func (s *Service) upsertLoginFailure(ctx context.Context, key string, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	record, err := getLoginFailureForUpdate(ctx, tx, key)
	if errors.Is(err, pgx.ErrNoRows) || record.ResetAt.Before(now) {
		record = LoginFailureRecord{Count: 1, ResetAt: now.Add(loginWindow)}
	} else if err == nil {
		record.Count++
	} else {
		return err
	}

	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'login_fail', $2)
		ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated_at = clock_timestamp()
	`, key, payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func getLoginFailureForUpdate(ctx context.Context, tx pgx.Tx, key string) (LoginFailureRecord, error) {
	var record LoginFailureRecord
	var payload []byte
	err := tx.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'login_fail' FOR UPDATE`, key).Scan(&payload)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(payload, &record)
	return record, err
}

func HashPassword(password string) (PasswordHash, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return PasswordHash{}, err
	}
	const memoryKiB = 19 * 1024
	const iterations = 2
	const parallelism = 1
	hash := argon2.IDKey([]byte(password), salt, iterations, memoryKiB, parallelism, 32)
	return PasswordHash{
		Algorithm:   "argon2id",
		MemoryKiB:   memoryKiB,
		Time:        iterations,
		Parallelism: parallelism,
		Salt:        base64.RawStdEncoding.EncodeToString(salt),
		Hash:        base64.RawStdEncoding.EncodeToString(hash),
	}, nil
}

func VerifyPassword(password string, stored PasswordHash) bool {
	if stored.Algorithm != "argon2id" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(stored.Salt)
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(stored.Hash)
	if err != nil {
		return false
	}
	if len(expected) > maxArgon2HashLength {
		return false
	}
	//nolint:gosec // bounded by maxArgon2HashLength immediately above.
	keyLength := uint32(len(expected))
	actual := argon2.IDKey([]byte(password), salt, stored.Time, stored.MemoryKiB, stored.Parallelism, keyLength)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func sessionID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "session:" + hex.EncodeToString(sum[:])
}

func sameSiteMode(cfg *config.Config) http.SameSite {
	if cfg == nil {
		return http.SameSiteLaxMode
	}
	switch strings.ToLower(strings.TrimSpace(cfg.AdminCookieSameSite)) {
	case "none":
		return http.SameSiteNoneMode
	case "strict":
		return http.SameSiteStrictMode
	default:
		return http.SameSiteLaxMode
	}
}

func developmentPassword() (string, error) {
	if path := strings.TrimSpace(os.Getenv("ATLAS_ADMIN_PASSWORD_FILE")); path != "" {
		//nolint:gosec // operator-selected local secret file path.
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read ATLAS_ADMIN_PASSWORD_FILE: %w", err)
		}
		return strings.TrimRight(string(data), "\r\n"), nil
	}
	if password := os.Getenv("ATLAS_ADMIN_PASSWORD"); password != "" {
		return password, nil
	}
	return defaultPass, nil
}
