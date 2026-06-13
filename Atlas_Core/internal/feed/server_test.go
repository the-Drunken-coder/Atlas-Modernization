package feed

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestWebsocketFeedStartsUnsubscribedAndAllowsLiveSubscribe(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{Hub: hub}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	readHandshake(t, conn)
	hub.Publish(entityEvent("create", "asset-before-subscribe", 1, "asset"))

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe all: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-after-subscribe", 2, "asset"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 2 || event.ID != "asset-after-subscribe" {
		t.Fatalf("unexpected event after subscribe: %+v", event)
	}
}

func TestWebsocketFeedUnsubscribeStopsDelivery(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{Hub: hub}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe all: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-before-unsubscribe", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-before-unsubscribe" {
		t.Fatalf("unexpected event before unsubscribe: %+v", event)
	}

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"unsubscribe","filter":"all"}`)); err != nil {
		t.Fatalf("unsubscribe all: %v", err)
	}
	waitForNoSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-after-unsubscribe", 2, "asset"))
	assertNoFeedEvent(t, conn)
}

func TestWebsocketFeedAllowsMultipleSubscriptions(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{Hub: hub}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe all: %v", err)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"id","resource_type":"entity","id":"asset-specific"}`)); err != nil {
		t.Fatalf("subscribe entity id: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	waitForSubscription(t, hub, Subscription{Filter: FilterID, ResourceType: protocol.ResourceTypeEntity, ID: "asset-specific"})

	hub.Publish(entityEvent("create", "asset-specific", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-specific" || event.Version != 1 {
		t.Fatalf("unexpected specific event: %+v", event)
	}
	hub.Publish(taskEvent("create", "task-from-all", 2, "", "asset-specific", "pending"))
	readFeedEvent(t, conn, &event)
	if event.ID != "task-from-all" || event.Version != 2 {
		t.Fatalf("unexpected all-subscription event: %+v", event)
	}
}

func TestWebsocketFeedDuplicateSubscriptionsAreIdempotent(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{Hub: hub}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	readHandshake(t, conn)
	for i := 0; i < 2; i++ {
		if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
			t.Fatalf("subscribe all %d: %v", i, err)
		}
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-duplicate-sub", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-duplicate-sub" {
		t.Fatalf("unexpected duplicate-subscription event: %+v", event)
	}
	assertNoFeedEvent(t, conn)
}

func TestWebsocketFeedFirstMessageAuthWhenEnabled(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
			APIKey:        "secret",
		},
	}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("auth feed: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"type","resource_type":"task"}`)); err != nil {
		t.Fatalf("subscribe task type: %v", err)
	}
	waitForSubscription(t, hub, Subscription{
		Filter:       FilterType,
		ResourceType: protocol.ResourceTypeTask,
	})
	hub.Publish(taskEvent("create", "task-auth", 1, "", "asset-1", "pending"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 1 || event.ResourceType != protocol.ResourceTypeTask {
		t.Fatalf("unexpected authenticated feed event: %+v", event)
	}
}

func TestWebsocketFeedRejectsAuthEnabledWithoutAPIKey(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
		},
	}.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "feed API key is not configured") {
		t.Fatalf("body = %q, want API key configuration error", rec.Body.String())
	}
}

func TestWebsocketFeedFirstMessageAuthRejectsMissingFirstFrame(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsMalformedJSON(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth"`)); err != nil {
		t.Fatalf("write malformed auth: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsWrongKey(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"wrong"}`)); err != nil {
		t.Fatalf("write wrong auth: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsEmptyKey(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":""}`)); err != nil {
		t.Fatalf("write empty auth: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsMissingKey(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth"}`)); err != nil {
		t.Fatalf("write auth without key: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsSubscribe(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("write first-frame subscribe: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedFirstMessageAuthRejectsBinaryAuthFrame(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageBinary, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("write binary auth frame: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedRejectsAuthEnabledWithWhitespaceAPIKey(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
			APIKey:        "  ",
		},
	}.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "feed API key is not configured") {
		t.Fatalf("body = %q, want API key configuration error", rec.Body.String())
	}
}

func TestWebsocketFeedFirstMessageAuthRejectsAuthAfterHandshake(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("auth feed: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe feed: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-after-auth", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-after-auth" || event.Version != 1 {
		t.Fatalf("unexpected event after auth: %+v", event)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("write second auth: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

// TestWebsocketFeedFirstMessageAuthRejectsAuthAfterSubscription sends the late
// auth frame only after a subscribe and event read, proving established sessions
// still reject auth frames after normal feed traffic.
func TestWebsocketFeedFirstMessageAuthRejectsAuthAfterSubscription(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("auth feed: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})
	hub.Publish(entityEvent("create", "asset-after-subscription", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-after-subscription" || event.Version != 1 {
		t.Fatalf("unexpected event after subscription: %+v", event)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("write late auth: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedClosesWhenHubClosesWhileReadSideIdle(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("auth feed: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe feed: %v", err)
	}
	waitForSubscription(t, hub, Subscription{Filter: FilterAll})

	hub.Close()

	expectFeedClosedWithStatus(t, conn, websocket.StatusInternalError)
}

func TestWebsocketFeedRejectsBinaryFrame(t *testing.T) {
	hub := NewHub(0, Options{})
	defer hub.Close()
	server := newAuthFeedServer(t, hub)
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"secret"}`)); err != nil {
		t.Fatalf("auth feed: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageBinary, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("write binary frame: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusUnsupportedData)
}

func newAuthFeedServer(t *testing.T, hub *Hub) *httptest.Server {
	t.Helper()
	return newAuthFeedServerWithKey(t, hub, "secret")
}

func newAuthFeedServerWithKey(t *testing.T, hub *Hub, apiKey string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
			APIKey:        apiKey,
			AuthTimeout:   2 * time.Second,
		},
	}.ServeHTTP))
}

func expectFeedClosedWithStatus(t *testing.T, conn *websocket.Conn, expected websocket.StatusCode) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := conn.Read(readCtx)
	if err == nil {
		t.Fatal("expected feed websocket to close")
	}
	var closeErr websocket.CloseError
	if !errors.As(err, &closeErr) {
		t.Fatalf("expected websocket close error, got %T: %v", err, err)
	}
	if closeErr.Code != expected {
		t.Fatalf("expected feed websocket close status %v, got %v", expected, closeErr.Code)
	}
}

func readHandshake(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	var hello protocol.FeedHandshakeMessage
	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	messageType, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read feed handshake: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("handshake message type = %v, want text", messageType)
	}
	if err := json.Unmarshal(data, &hello); err != nil {
		t.Fatalf("decode feed handshake: %v", err)
	}
	if hello.Type != "hello" || hello.ProtocolRevision != protocol.ProtocolRevision {
		t.Fatalf("unexpected feed handshake: %+v", hello)
	}
}

func dialFeed(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.Dial(context.Background(), websocketURL(url), nil)
	if response != nil && response.Body != nil {
		defer func() {
			_ = response.Body.Close()
		}()
	}
	if err != nil {
		t.Fatalf("dial feed: %v", err)
	}
	return conn
}

func readFeedEvent(t *testing.T, conn *websocket.Conn, event *protocol.FeedEvent) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read feed event: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v, want text", messageType)
	}
	if err := json.Unmarshal(data, event); err != nil {
		t.Fatalf("decode feed event: %v", err)
	}
}

func assertNoFeedEvent(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if _, _, err := conn.Read(readCtx); err == nil {
		t.Fatal("unexpected feed event")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("read feed event error = %v, want deadline exceeded", err)
	}
}

func waitForSubscription(t *testing.T, hub *Hub, sub Subscription) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	key := sub.Key()

	for {
		if hubHasSubscription(hub, key) {
			return
		}

		select {
		case <-deadline:
			t.Fatalf("timed out waiting for feed subscription %q", key)
		case <-ticker.C:
		}
	}
}

func waitForNoSubscription(t *testing.T, hub *Hub, sub Subscription) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	key := sub.Key()

	for {
		if !hubHasSubscription(hub, key) {
			return
		}

		select {
		case <-deadline:
			t.Fatalf("timed out waiting for feed subscription %q to be removed", key)
		case <-ticker.C:
		}
	}
}

func hubHasSubscription(hub *Hub, key string) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for client := range hub.clients {
		client.mu.Lock()
		_, ok := client.subs[key]
		client.mu.Unlock()
		if ok {
			return true
		}
	}
	return false
}

func websocketURL(url string) string {
	return "ws" + strings.TrimPrefix(url, "http")
}
