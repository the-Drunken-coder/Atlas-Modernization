package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	atlasdb "github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestFeedReceivesHTTPWritesAfterBurnedVersion(t *testing.T) {
	pool := openFeedIntegrationPool(t)
	ctx := context.Background()
	currentVersion, err := actions.CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read current change version: %v", err)
	}

	hub := feed.NewHub(currentVersion, feed.Options{MissingVersionTimeout: 20 * time.Millisecond})
	defer hub.Close()
	handler := NewHandlerWithFeed(
		&atlasdb.DB{Pool: pool},
		nil,
		zerolog.Nop(),
		&config.Config{},
		hub,
	)

	router := chi.NewRouter()
	router.Get("/feed", handler.Feed)
	router.Post("/entities", handler.CreateEntity)
	server := httptest.NewServer(router)
	defer server.Close()

	conn := dialFeedIntegration(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()
	readFeedHandshakeIntegration(t, conn)

	subscription := feed.Subscription{Filter: feed.FilterAll}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe feed: %v", err)
	}
	waitForFeedSubscription(t, hub, subscription)

	prefix := fmt.Sprintf("feed-e2e-%d", time.Now().UTC().UnixNano())
	firstID := prefix + "-first"
	secondID := prefix + "-second"
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, []string{firstID, secondID}); err != nil {
			t.Errorf("cleanup feed integration entities: %v", err)
		}
	})

	first := postEntityIntegration(t, server.URL, firstID, http.StatusCreated)
	firstEvent := readFeedEventIntegration(t, conn)
	if firstEvent.ID != firstID || firstEvent.Version != first.Metadata.Version {
		t.Fatalf("first feed event = %+v, created = %+v", firstEvent, first)
	}

	_ = postEntityIntegration(t, server.URL, firstID, http.StatusConflict)
	second := postEntityIntegration(t, server.URL, secondID, http.StatusCreated)
	if second.Metadata.Version <= first.Metadata.Version+1 {
		t.Fatalf("duplicate create did not burn a version: first=%d second=%d", first.Metadata.Version, second.Metadata.Version)
	}

	secondEvent := readFeedEventIntegration(t, conn)
	if secondEvent.ID != secondID || secondEvent.Version != second.Metadata.Version {
		t.Fatalf("second feed event = %+v, created = %+v", secondEvent, second)
	}
}

func openFeedIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, explicitDBURL := feedIntegrationDatabaseURL()
	if dbURL == "" {
		t.Skip("set ATLAS_ACTIONS_DATABASE_URL, DATABASE_URL, or POSTGRES_PASSWORD to run DB-backed feed integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		if explicitDBURL {
			t.Fatalf("connect test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		if explicitDBURL {
			t.Fatalf("ping test database: %v", err)
		}
		t.Skipf("test database unavailable: %v", err)
	}
	if ok, err := feedIntegrationCoreSchemaPresent(ctx, pool); err != nil {
		t.Fatalf("check core schema: %v", err)
	} else if !ok {
		t.Skip("core schema is not present in test database")
	}
	return pool
}

func feedIntegrationDatabaseURL() (string, bool) {
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

func feedIntegrationCoreSchemaPresent(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT to_regclass('public.entities') IS NOT NULL
			AND to_regclass('public.atlas_change_version_seq') IS NOT NULL
	`).Scan(&ok)
	return ok, err
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

func dialFeedIntegration(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.Dial(context.Background(), "ws"+serverURL[len("http"):]+"/feed", nil)
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
