package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	atlasdb "github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/testenv"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const feedIntegrationAPIKey = "feed-integration-key"

func TestFeedReadsCommittedEventsWithoutRejectedWriteGaps(t *testing.T) {
	pool := openIsolatedFeedIntegrationPool(t)
	ctx := context.Background()
	currentVersion, err := actions.CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read current change version: %v", err)
	}

	hub := feed.NewHub(feed.Options{})
	dispatchCtx, stopDispatcher := context.WithCancel(ctx)
	dispatcherDone := make(chan struct{})
	go func() {
		defer close(dispatcherDone)
		feed.NewDispatcher(pool, hub, currentVersion).Run(dispatchCtx)
	}()
	t.Cleanup(func() {
		stopDispatcher()
		<-dispatcherDone
		hub.Close()
	})
	handler := NewHandlerWithFeed(
		&atlasdb.DB{Pool: pool},
		nil,
		zerolog.Nop(),
		&config.Config{EnableAPIAuth: true, APIAuthKey: feedIntegrationAPIKey},
		hub,
		nil,
	)
	handler.taskActions = actions.NewTaskActionsWithCatalog(pool, taskingHandlerFixture[protocol.CommandCatalog](t, "catalog.json"))

	router := chi.NewRouter()
	router.Get("/feed", handler.Feed)
	router.Post("/entities", handler.CreateEntity)
	router.Post("/tasks", handler.CreateTask)
	server := httptest.NewServer(router)
	defer server.Close()

	conn := dialFeedIntegration(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()
	readFeedHandshakeIntegration(t, conn)

	prefix := fmt.Sprintf("feed-e2e-%d", time.Now().UTC().UnixNano())
	firstID := prefix + "-first"
	secondID := prefix + "-second"
	thirdID := prefix + "-third"
	unregisteredAssetID := prefix + "-unregistered"
	_ = postEntityIntegration(t, server.URL, unregisteredAssetID, http.StatusCreated)
	for _, entityID := range []string{firstID, secondID, thirdID} {
		message := fmt.Sprintf(`{"action":"subscribe","filter":"id","resource_type":"entity","id":%q}`, entityID)
		if err := conn.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
			t.Fatalf("subscribe to entity %s feed events: %v", entityID, err)
		}
		waitForFeedSubscription(t, hub, feed.Subscription{
			Filter:       protocol.FeedFilterID,
			ResourceType: protocol.ResourceTypeEntity,
			ID:           entityID,
		})
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, []string{firstID, secondID, thirdID, unregisteredAssetID}); err != nil {
			t.Errorf("cleanup feed integration entities: %v", err)
		}
	})

	first := postEntityIntegration(t, server.URL, firstID, http.StatusCreated)
	firstEvent := readFeedEventIntegration(t, conn)
	assertEntityCreateFeedEventIntegration(t, firstEvent, firstID, first)

	_ = postEntityIntegration(t, server.URL, firstID, http.StatusConflict)
	duplicateVersion, err := actions.CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version after duplicate create: %v", err)
	}
	if duplicateVersion != first.Metadata.Version {
		t.Fatalf("duplicate create advanced version to %d, want %d", duplicateVersion, first.Metadata.Version)
	}

	postTaskIntegration(t, server.URL, prefix+"-unregistered-asset-task", unregisteredAssetID, http.StatusBadRequest)
	rejectedTaskVersion, err := actions.CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version after rejected Task: %v", err)
	}
	if rejectedTaskVersion != duplicateVersion {
		t.Fatalf("rejected Task advanced version to %d, want %d", rejectedTaskVersion, duplicateVersion)
	}

	second := postEntityIntegration(t, server.URL, secondID, http.StatusCreated)
	third := postEntityIntegration(t, server.URL, thirdID, http.StatusCreated)
	if second.Metadata.Version != rejectedTaskVersion+1 || third.Metadata.Version != second.Metadata.Version+1 {
		t.Fatalf("successful versions after rejected writes = %d, %d; want %d, %d", second.Metadata.Version, third.Metadata.Version, rejectedTaskVersion+1, rejectedTaskVersion+2)
	}

	secondEvent := readFeedEventIntegration(t, conn)
	assertEntityCreateFeedEventIntegration(t, secondEvent, secondID, second)
	thirdEvent := readFeedEventIntegration(t, conn)
	assertEntityCreateFeedEventIntegration(t, thirdEvent, thirdID, third)
}

func openIsolatedFeedIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicitDBURL := testenv.DatabaseURL("ATLAS_ACTIONS_DATABASE_URL")
	if dbURL == "" {
		testenv.SkipOrFatal(t, "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed feed integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	adminConn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect feed integration database: %v", err)
		}
		testenv.SkipOrFatal(t, "feed integration database unavailable: %v", err)
	}

	schema := fmt.Sprintf("atlas_feed_test_%d", time.Now().UTC().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := adminConn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = adminConn.Close(context.Background())
		if explicitDBURL {
			t.Fatalf("create isolated feed integration schema: %v", err)
		}
		testenv.SkipOrFatal(t, "feed integration database unavailable: %v", err)
	}
	var db *atlasdb.DB
	t.Cleanup(func() {
		if db != nil {
			db.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := adminConn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated feed integration schema %s: %v", schema, err)
		}
		if err := adminConn.Close(cleanupCtx); err != nil {
			t.Errorf("close feed integration database connection: %v", err)
		}
	})

	parsed, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse feed integration database URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err = atlasdb.New(&config.Config{
		DatabaseURL:             parsed.String(),
		DatabasePoolSize:        1,
		DatabaseMaxOverflow:     1,
		DatabasePoolRecycle:     3600,
		DatabasePoolTimeout:     10,
		DatabasePoolIdleTimeout: 30,
		DatabasePoolPrePing:     false,
	})
	if err != nil {
		t.Fatalf("open isolated feed integration database: %v", err)
	}
	if err := db.EnsureTables(ctx); err != nil {
		t.Fatalf("initialize isolated feed integration schema: %v", err)
	}
	return db.Pool
}

func TestFeedAPIKeyTakesPrecedenceOverSessionOrigin(t *testing.T) {
	pool := openFeedIntegrationPool(t)
	ctx := context.Background()
	adminAuth := admin.NewService(pool, &config.Config{AdminCookieSameSite: "none"})
	now := time.Now().UTC()
	username := fmt.Sprintf("feed-auth-order-account-%d", now.UnixNano())
	accountID := "account:" + username
	token := fmt.Sprintf("feed-auth-order-session-%d", now.UnixNano())
	sessionID := feedIntegrationSessionID(token)
	account := admin.AccountRecord{
		Username: username,
	}
	session := admin.SessionRecord{
		AccountID: accountID,
		Username:  username,
		ExpiresAt: now.Add(time.Hour),
	}
	if err := storeFeedIntegrationAdminRecord(ctx, pool, accountID, "account", account); err != nil {
		t.Fatalf("store feed integration account: %v", err)
	}
	if err := storeFeedIntegrationAdminRecord(ctx, pool, sessionID, "session", session); err != nil {
		t.Fatalf("store feed integration session: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM admin_records WHERE id = ANY($1)`, []string{accountID, sessionID}); err != nil {
			t.Errorf("cleanup feed integration admin records: %v", err)
		}
	})

	hub := feed.NewHub(feed.Options{})
	defer hub.Close()
	handler := NewHandlerWithFeed(
		&atlasdb.DB{Pool: pool},
		nil,
		zerolog.Nop(),
		&config.Config{
			EnableAPIAuth: true,
			APIAuthKey:    feedIntegrationAPIKey,
			CORSOrigins:   []string{"https://trusted-ui.test"},
		},
		hub,
		adminAuth,
	)

	router := chi.NewRouter()
	router.Get("/feed", handler.Feed)
	server := httptest.NewServer(router)
	defer server.Close()

	conn := dialFeedIntegrationWithHeaders(t, server.URL, http.Header{
		"Cookie":    []string{admin.CookieName + "=" + token},
		"Origin":    []string{"https://evil-ui.test"},
		"X-API-Key": []string{feedIntegrationAPIKey},
	})
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()
	readFeedHandshakeIntegration(t, conn)
}

func assertEntityCreateFeedEventIntegration(t *testing.T, event protocol.FeedEvent, wantID string, created feedIntegrationEntity) {
	t.Helper()
	if event.Event != protocol.FeedEventCreate || event.ResourceType != protocol.ResourceTypeEntity || event.ID != wantID || event.Version != created.Metadata.Version {
		t.Fatalf("feed event = %+v, created = %+v", event, created)
	}
	resource, ok := event.Resource.(map[string]any)
	if !ok {
		t.Fatalf("feed event resource = %T, want object", event.Resource)
	}
	if resource["entity_id"] != wantID || resource["entity_type"] != "asset" {
		t.Fatalf("feed event resource = %#v, want entity %s/asset", resource, wantID)
	}
	metadata, ok := resource["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("feed event resource metadata = %T, want object", resource["metadata"])
	}
	if metadata["version"] != float64(created.Metadata.Version) {
		t.Fatalf("feed event resource metadata = %#v, want version %d", metadata, created.Metadata.Version)
	}
}

func openFeedIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testenv.OpenDatabasePool(t, "ATLAS_ACTIONS_DATABASE_URL", "set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed feed integration tests")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if ok, err := feedIntegrationCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		testenv.SkipOrFatal(t, "core schema is not present in test database")
	}
	return pool
}

func feedIntegrationCoreSchemaPresent(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.entities') IS NOT NULL
			AND to_regclass('public.tasks') IS NOT NULL
			AND to_regclass('public.objects') IS NOT NULL
			AND to_regclass('public.atlas_change_clock') IS NOT NULL
			AND to_regclass('public.atlas_change_events') IS NOT NULL
			AND to_regclass('public.admin_records') IS NOT NULL
	`).Scan(&ok)
	return ok, err
}

func storeFeedIntegrationAdminRecord(ctx context.Context, pool *pgxpool.Pool, id, recordType string, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO admin_records (id, type, json)
		VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated_at = clock_timestamp()
	`, id, recordType, payload)
	return err
}

func feedIntegrationSessionID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "session:" + hex.EncodeToString(sum[:])
}

type feedIntegrationEntity struct {
	EntityID string `json:"entity_id"`
	Metadata struct {
		Version int64 `json:"version"`
	} `json:"metadata"`
}

func postEntityIntegration(t *testing.T, serverURL, entityID string, wantStatus int) feedIntegrationEntity {
	t.Helper()
	payload := map[string]any{
		"entity_id":   entityID,
		"entity_type": "asset",
		"components":  map[string]any{},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal entity payload: %v", err)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Post(serverURL+"/entities", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post entity %s: %v", entityID, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		if err := response.Body.Close(); err != nil {
			t.Errorf("close entity response body: %v", err)
		}
	}()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("POST /entities %s status = %d, want %d, body=%s", entityID, response.StatusCode, wantStatus, data)
	}
	if response.StatusCode != http.StatusCreated {
		return feedIntegrationEntity{}
	}
	var entity feedIntegrationEntity
	if err := json.NewDecoder(response.Body).Decode(&entity); err != nil {
		t.Fatalf("decode entity response: %v", err)
	}
	return entity
}

func postTaskIntegration(t *testing.T, serverURL, taskID, entityID string, wantStatus int) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"asset_id": entityID,
		"command":  "fixture.queued",
		"input":    map[string]any{"value": "rejected"},
	})
	if err != nil {
		t.Fatalf("marshal task payload: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/tasks", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build task request %s: %v", taskID, err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", taskID)
	response, err := (&http.Client{Timeout: 2 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("post task %s: %v", taskID, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		if err := response.Body.Close(); err != nil {
			t.Errorf("close task response body: %v", err)
		}
	}()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("POST /tasks %s status = %d, want %d, body=%s", taskID, response.StatusCode, wantStatus, data)
	}
}

func dialFeedIntegration(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	return dialFeedIntegrationWithHeaders(t, serverURL, http.Header{"X-API-Key": []string{feedIntegrationAPIKey}})
}

func dialFeedIntegrationWithHeaders(t *testing.T, serverURL string, headers http.Header) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.Dial(context.Background(), "ws"+serverURL[len("http"):]+"/feed", &websocket.DialOptions{HTTPHeader: headers})
	if response != nil && response.Body != nil {
		defer func() {
			_, _ = io.Copy(io.Discard, response.Body)
			if err := response.Body.Close(); err != nil {
				t.Errorf("close feed dial response body: %v", err)
			}
		}()
	}
	if err != nil {
		t.Fatalf("dial feed: %v", err)
	}
	return conn
}

func readFeedHandshakeIntegration(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	var hello protocol.FeedHandshakeMessage
	readFeedJSONIntegration(t, conn, &hello)
	if hello.Type != "hello" || hello.ProtocolRevision != protocol.ProtocolRevision {
		t.Fatalf("unexpected feed hello: %+v", hello)
	}
}

func readFeedEventIntegration(t *testing.T, conn *websocket.Conn) protocol.FeedEvent {
	t.Helper()
	var event protocol.FeedEvent
	readFeedJSONIntegration(t, conn, &event)
	return event
}

func readFeedJSONIntegration(t *testing.T, conn *websocket.Conn, target any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read feed frame: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("feed message type = %v, want text", messageType)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("decode feed frame %s: %v", data, err)
	}
}

func waitForFeedSubscription(t *testing.T, hub *feed.Hub, sub feed.Subscription) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if hub.HasSubscription(sub) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for feed subscription")
		case <-ticker.C:
		}
	}
}
