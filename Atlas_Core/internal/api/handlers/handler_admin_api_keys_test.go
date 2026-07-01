package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func TestAdminAPIKeyHandlersCreateListAndRevoke(t *testing.T) {
	pool := openHandlerAdminTestPool(t)
	ctx := context.Background()
	cleanupHandlerAdminRows(ctx, t, pool)

	cfg := &config.Config{AdminCookieSameSite: "lax", CORSOrigins: []string{"https://ui.test"}}
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

	cfg := &config.Config{AdminCookieSameSite: "lax", CORSOrigins: []string{"https://ui.test"}}
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

func loginAdminCookie(t *testing.T, service *admin.Service) *http.Cookie {
	t.Helper()
	token, session, err := service.Login(context.Background(), "admin", "password", "127.0.0.1", time.Now().UTC())
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
	dbURL, explicit := handlerAdminTestDatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed handler admin tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicit {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		if explicit {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if _, err := pool.Exec(ctx, `SELECT 1 FROM admin_records LIMIT 1`); err != nil {
		t.Skipf("admin_records table is not present: %v", err)
	}
	return pool
}

func cleanupHandlerAdminRows(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM admin_records`); err != nil {
		t.Fatalf("cleanup admin records: %v", err)
	}
}

func handlerAdminTestDatabaseURL() (string, bool) {
	if dbURL := os.Getenv("ATLAS_ACTIONS_DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		return dbURL, true
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	if password == "" {
		return "", false
	}
	dbURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword("atlas", password),
		Host:   "localhost:5432",
		Path:   "/atlas_core",
	}
	return dbURL.String(), false
}
