// Package admin owns Atlas Core browser account and session authentication.
package admin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"golang.org/x/crypto/argon2"
)

const (
	CookieName                       = "atlas_session"
	defaultUser                      = "admin"
	defaultPass                      = "password"
	minProductionAdminPasswordLength = 12
	sessionTTL                       = 7 * 24 * time.Hour
	loginWindow                      = 15 * time.Minute
	loginMaxFails                    = 8
	// Four concurrent Argon2 verifications cap the login path at roughly 76 MiB
	// with hashes created by HashPassword.
	loginArgon2Concurrency = 4

	maxArgon2HashLength = 1<<32 - 1
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrTooManyAttempts    = errors.New("too many login attempts")
	ErrInvalidSession     = errors.New("invalid session")

	dummyPasswordHash = PasswordHash{
		Algorithm:   "argon2id",
		MemoryKiB:   19 * 1024,
		Time:        2,
		Parallelism: 1,
		Salt:        "AAAAAAAAAAAAAAAAAAAAAA",
		Hash:        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	}
	loginArgon2Slots = make(chan struct{}, loginArgon2Concurrency)
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
}

type SessionRecord struct {
	AccountID string    `json:"account_id"`
	Username  string    `json:"username"`
	ExpiresAt time.Time `json:"expires_at"`
}

type LoginFailureRecord struct {
	Count   int       `json:"count"`
	ResetAt time.Time `json:"reset_at"`
}

type AuthenticatedSession struct {
	AccountID string
	Username  string
	ExpiresAt time.Time
}

type Service struct {
	pool           *pgxpool.Pool
	cookieSameSite http.SameSite
	verifyPassword func(string, PasswordHash) bool
}

type adminStore interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func NewService(pool *pgxpool.Pool, cfg *config.Config) *Service {
	return &Service{pool: pool, cookieSameSite: sameSiteMode(cfg), verifyPassword: verifyPassword}
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
	account := AccountRecord{
		Username: defaultUser,
		Password: hash,
	}
	if UsesDefaultDevelopmentPassword() {
		return s.createAccountIfMissing(ctx, "account:"+defaultUser, account)
	}
	return s.upsertAccount(ctx, "account:"+defaultUser, account)
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

func (s *Service) upsertAccount(ctx context.Context, id string, account AccountRecord) error {
	payload, err := json.Marshal(account)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'account', $2)
		ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated_at = clock_timestamp()
	`, id, payload)
	return err
}

func (s *Service) GetAccount(ctx context.Context, id string) (AccountRecord, error) {
	return getAccount(ctx, s.pool, id)
}

func getAccount(ctx context.Context, store adminStore, id string) (AccountRecord, error) {
	var account AccountRecord
	var payload []byte
	err := store.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'account'`, id).Scan(&payload)
	if err != nil {
		return account, err
	}
	err = json.Unmarshal(payload, &account)
	return account, err
}

func (s *Service) Login(ctx context.Context, username, password, ip string, now time.Time) (string, SessionRecord, error) {
	username = strings.TrimSpace(username)
	ip = strings.TrimSpace(ip)
	if username == "" || password == "" {
		return "", SessionRecord{}, ErrInvalidCredentials
	}
	if err := s.CleanupExpiredAuthRecords(ctx, now); err != nil {
		return "", SessionRecord{}, err
	}
	if throttled, err := loginThrottled(ctx, s.pool, username, ip, now); err != nil {
		return "", SessionRecord{}, err
	} else if throttled {
		return "", SessionRecord{}, ErrTooManyAttempts
	}

	accountID := "account:" + username
	account, accountErr := getAccount(ctx, s.pool, accountID)
	passwordHash := dummyPasswordHash
	accountExists := accountErr == nil
	if accountErr == nil {
		passwordHash = account.Password
	}
	releaseSlot, err := acquireLoginSlot(ctx, loginArgon2Slots)
	if err != nil {
		return "", SessionRecord{}, err
	}
	passwordMatches := func() bool {
		defer releaseSlot()
		return s.verifyPassword(password, passwordHash)
	}()
	if accountErr != nil && !errors.Is(accountErr, pgx.ErrNoRows) {
		return "", SessionRecord{}, accountErr
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", SessionRecord{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockLoginAdmission(ctx, tx, username, ip); err != nil {
		return "", SessionRecord{}, err
	}
	if throttled, err := loginThrottled(ctx, tx, username, ip, now); err != nil {
		return "", SessionRecord{}, err
	} else if throttled {
		return "", SessionRecord{}, ErrTooManyAttempts
	}
	if !passwordMatches || !accountExists {
		if err := recordLoginFailure(ctx, tx, username, ip, now); err != nil {
			return "", SessionRecord{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", SessionRecord{}, err
		}
		return "", SessionRecord{}, ErrInvalidCredentials
	}
	if err := clearLoginFailures(ctx, tx, username, ip); err != nil {
		return "", SessionRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", SessionRecord{}, err
	}

	token, err := randomToken()
	if err != nil {
		return "", SessionRecord{}, err
	}
	session := SessionRecord{
		AccountID: accountID,
		Username:  account.Username,
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
	if _, err := s.GetAccount(ctx, session.AccountID); err != nil {
		return AuthenticatedSession{}, ErrInvalidSession
	}
	return AuthenticatedSession(session), nil
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

func (s *Service) CleanupExpiredAuthRecords(ctx context.Context, now time.Time) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM admin_records
		WHERE (type = 'session' AND COALESCE((json->>'expires_at')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz)
		   OR (type = 'login_fail' AND COALESCE((json->>'reset_at')::timestamptz, '-infinity'::timestamptz) <= $1::timestamptz)
	`, now.UTC())
	return err
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
	return loginThrottled(ctx, s.pool, username, ip, now)
}

func loginThrottled(ctx context.Context, store adminStore, username, ip string, now time.Time) (bool, error) {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	for _, key := range keys {
		record, err := getLoginFailure(ctx, store, key)
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
	return recordLoginFailure(ctx, s.pool, username, ip, now)
}

func recordLoginFailure(ctx context.Context, store adminStore, username, ip string, now time.Time) error {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	for _, key := range keys {
		if err := upsertLoginFailure(ctx, store, key, now.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func clearLoginFailures(ctx context.Context, store adminStore, username, ip string) error {
	keys := []string{"login_fail:user:" + username}
	if strings.TrimSpace(ip) != "" {
		keys = append(keys, "login_fail:ip:"+ip)
	}
	_, err := store.Exec(ctx, `DELETE FROM admin_records WHERE id = ANY($1::text[]) AND type = 'login_fail'`, keys)
	return err
}

func getLoginFailure(ctx context.Context, store adminStore, key string) (LoginFailureRecord, error) {
	var record LoginFailureRecord
	var payload []byte
	err := store.QueryRow(ctx, `SELECT json FROM admin_records WHERE id = $1 AND type = 'login_fail'`, key).Scan(&payload)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(payload, &record)
	return record, err
}

func upsertLoginFailure(ctx context.Context, store adminStore, key string, now time.Time) error {
	_, err := store.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, 'login_fail', jsonb_build_object('count', 1, 'reset_at', $2::timestamptz))
		ON CONFLICT (id) DO UPDATE SET
			json = CASE
				WHEN COALESCE((admin_records.json->>'reset_at')::timestamptz, '-infinity'::timestamptz) <= $3::timestamptz THEN
					jsonb_build_object('count', 1, 'reset_at', $2::timestamptz)
				ELSE
					jsonb_build_object(
						'count', COALESCE((admin_records.json->>'count')::int, 0) + 1,
						'reset_at', (admin_records.json->>'reset_at')::timestamptz
					)
			END,
			updated_at = clock_timestamp()
		WHERE admin_records.type = 'login_fail'
	`, key, now.Add(loginWindow), now)
	return err
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
	release, err := acquireLoginSlot(context.Background(), loginArgon2Slots)
	if err != nil {
		return false
	}
	defer release()
	return verifyPassword(password, stored)
}

func verifyPassword(password string, stored PasswordHash) bool {
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

func acquireLoginSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func lockLoginAdmission(ctx context.Context, tx pgx.Tx, username, ip string) error {
	locks := []int64{loginAdmissionLockID("user:" + username)}
	if ip != "" {
		ipLock := loginAdmissionLockID("ip:" + ip)
		if ipLock != locks[0] {
			locks = append(locks, ipLock)
		}
	}
	if len(locks) == 2 && locks[0] > locks[1] {
		locks[0], locks[1] = locks[1], locks[0]
	}
	for _, lock := range locks {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lock); err != nil {
			return err
		}
	}
	return nil
}

func loginAdmissionLockID(key string) int64 {
	sum := sha256.Sum256([]byte(key))
	return int64(binary.BigEndian.Uint64(sum[:8])) //nolint:gosec // Preserve all hash bits in PostgreSQL's signed advisory-lock key.
}

// ClientIP returns the browser-login throttle identity after enforcing the
// immediate trusted-proxy boundary. An untrusted peer can never select its
// identity with forwarded headers.
func ClientIP(r *http.Request, trustedProxyCIDRs []netip.Prefix) string {
	peer, ok := parseRemoteIP(r.RemoteAddr)
	if !ok {
		return ""
	}
	if !ipInPrefixes(peer, trustedProxyCIDRs) {
		return peer.String()
	}

	if values := r.Header.Values("CF-Connecting-IP"); len(values) > 0 {
		if len(values) != 1 {
			// Do not collapse malformed trusted-proxy traffic into one proxy bucket;
			// Login still enforces its username throttle when the IP is empty.
			return ""
		}
		if ip, ok := parseForwardedIP(values[0]); ok {
			return ip.String()
		}
		return ""
	}

	return clientIPFromXForwardedFor(r.Header.Values("X-Forwarded-For"), trustedProxyCIDRs)
}

func parseRemoteIP(remoteAddr string) (netip.Addr, bool) {
	remoteAddr = strings.TrimSpace(remoteAddr)
	if peer, err := netip.ParseAddrPort(remoteAddr); err == nil {
		return peer.Addr().Unmap().WithZone(""), true
	}
	peer, err := netip.ParseAddr(remoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	return peer.Unmap().WithZone(""), true
}

func parseForwardedIP(value string) (netip.Addr, bool) {
	ip, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil || ip.Zone() != "" {
		return netip.Addr{}, false
	}
	return ip.Unmap(), true
}

func clientIPFromXForwardedFor(values []string, trustedProxyCIDRs []netip.Prefix) string {
	for valueIndex := len(values) - 1; valueIndex >= 0; valueIndex-- {
		entries := strings.Split(values[valueIndex], ",")
		for entryIndex := len(entries) - 1; entryIndex >= 0; entryIndex-- {
			ip, ok := parseForwardedIP(entries[entryIndex])
			if !ok {
				return ""
			}
			if !ipInPrefixes(ip, trustedProxyCIDRs) {
				return ip.String()
			}
		}
	}
	return ""
}

func ipInPrefixes(ip netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
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
		return http.SameSiteNoneMode
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
		password := strings.TrimRight(string(data), "\r\n")
		if strings.TrimSpace(password) == "" {
			return "", fmt.Errorf("ATLAS_ADMIN_PASSWORD_FILE must not be empty")
		}
		return password, nil
	}
	if password := os.Getenv("ATLAS_ADMIN_PASSWORD"); strings.TrimSpace(password) != "" {
		return password, nil
	}
	return defaultPass, nil
}

func UsesDefaultDevelopmentPassword() bool {
	return strings.TrimSpace(os.Getenv("ATLAS_ADMIN_PASSWORD_FILE")) == "" && strings.TrimSpace(os.Getenv("ATLAS_ADMIN_PASSWORD")) == ""
}

// ValidateProductionAdminPassword rejects credentials that are committed as
// development defaults or operator-facing examples.
func ValidateProductionAdminPassword() error {
	password, err := developmentPassword()
	if err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(password)) {
	case defaultPass, "replace_with_secure_admin_password", "replace-with-secure-admin-password", "your-secure-admin-password":
		return errors.New("configured admin password is a development default or example placeholder")
	}
	if utf8.RuneCountInString(strings.TrimSpace(password)) < minProductionAdminPasswordLength {
		return fmt.Errorf("configured admin password must be at least %d characters", minProductionAdminPasswordLength)
	}
	return nil
}
