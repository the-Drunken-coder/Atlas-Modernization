package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
)

// Serializes DB-backed admin tests that share admin_records across Go packages.
const handlerAdminRecordsTestLockKey int64 = 780078001

func TestAdminAPIKeyHandlersCreateListAndRevoke(t *testing.T) {
	pool := openHandlerAdminTestPool(t)
	ctx := context.Background()
	cleanupHandlerAdminRows(ctx, t, pool)

	cfg := &config.Config{AdminCookieSameSite: "lax", CORSOrigins: []string{"https://ui.test"}, EnableAPIAuth: true}
	adminAuth := admin.NewService(pool, cfg)
	if err := adminAuth.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	cookie := loginAdminCookie(t, adminAuth)
	handler := &Handler{logger: zerolog.Nop(), config: cfg, adminAuth: adminAuth}

	createReq := routeRequest(http.MethodPost, "/admin/api-keys", `{"name":"sim runner"}`)
	createReq.Header.Set("Origin", "https://ui.test")
	createReq.AddCookie(cookie)
	createRec := httptest.NewRecorder()
	handler.AdminCreateAPIKey(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", createRec.Code, createRec.Body.String())
	}
	createBody := decodeBody(t, createRec)
	apiKey, ok := createBody["api_key"].(string)
	if !ok || !strings.HasPrefix(apiKey, "atlas_ak_") {
		t.Fatalf("expected one-time api_key in create response, got %#v", createBody["api_key"])
	}
	keyID, ok := createBody["id"].(string)
	if !ok || keyID == "" {
		t.Fatalf("expected id in create response, got %#v", createBody["id"])
	}

	listReq := httptest.NewRequest(http.MethodGet, "/admin/api-keys", nil)
	listReq.AddCookie(cookie)
	listRec := httptest.NewRecorder()
	handler.AdminListAPIKeys(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d, body=%s", listRec.Code, listRec.Body.String())
	}
	var listed []map[string]interface{}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(listed) != 1 || listed[0]["id"] != keyID {
		t.Fatalf("unexpected list response: %#v", listed)
	}
	if _, leaked := listed[0]["api_key"]; leaked {
		t.Fatalf("list response leaked full api key: %#v", listed[0])
	}

	deleteReq := withURLParam(httptest.NewRequest(http.MethodDelete, "/admin/api-keys/"+keyID, nil), "key_id", keyID)
	deleteReq.Header.Set("Origin", "https://ui.test")
	deleteReq.AddCookie(cookie)
	deleteRec := httptest.NewRecorder()
	handler.AdminRevokeAPIKey(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body=%s", deleteRec.Code, deleteRec.Body.String())
	}

	deleteAgainReq := withURLParam(httptest.NewRequest(http.MethodDelete, "/admin/api-keys/"+keyID, nil), "key_id", keyID)
	deleteAgainReq.Header.Set("Origin", "https://ui.test")
	deleteAgainReq.AddCookie(cookie)
	deleteAgainRec := httptest.NewRecorder()
	handler.AdminRevokeAPIKey(deleteAgainRec, deleteAgainReq)
	if deleteAgainRec.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, body=%s", deleteAgainRec.Code, deleteAgainRec.Body.String())
	}
}

func TestAdminCreateAPIKeyValidatesName(t *testing.T) {
	pool := openHandlerAdminTestPool(t)
	ctx := context.Background()
	cleanupHandlerAdminRows(ctx, t, pool)

	cfg := &config.Config{AdminCookieSameSite: "lax", CORSOrigins: []string{"https://ui.test"}, EnableAPIAuth: true}
	adminAuth := admin.NewService(pool, cfg)
	if err := adminAuth.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	handler := &Handler{logger: zerolog.Nop(), config: cfg, adminAuth: adminAuth}
	req := routeRequest(http.MethodPost, "/admin/api-keys", `{"name":"   "}`)
	req.Header.Set("Origin", "https://ui.test")
	req.AddCookie(loginAdminCookie(t, adminAuth))
	rec := httptest.NewRecorder()
	handler.AdminCreateAPIKey(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminCreateAPIKeyRejectsDisabledAPIAuth(t *testing.T) {
	pool := openHandlerAdminTestPool(t)
	ctx := context.Background()
	cleanupHandlerAdminRows(ctx, t, pool)

	cfg := &config.Config{AdminCookieSameSite: "lax", CORSOrigins: []string{"https://ui.test"}}
	adminAuth := admin.NewService(pool, cfg)
	if err := adminAuth.SeedDevelopmentAdmin(ctx); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	handler := &Handler{logger: zerolog.Nop(), config: cfg, adminAuth: adminAuth}
	req := routeRequest(http.MethodPost, "/admin/api-keys", `{"name":"sim runner"}`)
	req.Header.Set("Origin", "https://ui.test")
	req.AddCookie(loginAdminCookie(t, adminAuth))
	rec := httptest.NewRecorder()
	handler.AdminCreateAPIKey(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if body["message"] != "API key auth is disabled; set ENABLE_API_AUTH=true before creating managed API keys" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
	keys, err := adminAuth.ListAPIKeys(ctx)
	if err != nil {
		t.Fatalf("list api keys: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("expected no created keys, got %#v", keys)
	}
}

func loginAdminCookie(t *testing.T, service *admin.Service) *http.Cookie {
	t.Helper()
	password := strings.TrimSpace(os.Getenv("ATLAS_ADMIN_PASSWORD"))
	if password == "" {
		password = "password"
	}
	token, session, err := service.Login(context.Background(), "admin", password, "127.0.0.1", time.Now().UTC())
	if err != nil {
		t.Fatalf("login admin: %v", err)
	}
	rec := httptest.NewRecorder()
	service.SetSessionCookie(rec, token, session.ExpiresAt)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one session cookie, got %#v", cookies)
	}
	return cookies[0]
}

func openHandlerAdminTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testenv.OpenDatabasePool(t, "ATLAS_ACTIONS_DATABASE_URL", "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed handler admin tests")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, `SELECT 1 FROM admin_records LIMIT 1`); err != nil {
		testenv.SkipOrFatal(t, "admin_records table is not present: %v", err)
	}
	lockHandlerAdminRecords(ctx, t, pool)
	return pool
}

func lockHandlerAdminRecords(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire admin_records test lock connection: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, handlerAdminRecordsTestLockKey); err != nil {
		conn.Release()
		t.Fatalf("lock admin_records tests: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanupCtx, `SELECT pg_advisory_unlock($1)`, handlerAdminRecordsTestLockKey); err != nil {
			t.Errorf("unlock admin_records tests: %v", err)
		}
		conn.Release()
	})
}

func cleanupHandlerAdminRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM admin_records`); err != nil {
		t.Fatalf("cleanup admin records: %v", err)
	}
}
