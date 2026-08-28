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
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func TestWebsocketFeedStartsUnsubscribedAndAllowsLiveSubscribe(t *testing.T) {
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
	hub.Publish(entityEvent("create", "asset-after-subscribe", 2, "asset"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 2 || event.ID != "asset-after-subscribe" {
		t.Fatalf("unexpected event after subscribe: %+v", event)
	}
}

func TestWebsocketFeedAcknowledgesInstalledInitialSubscriptions(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		CurrentVersion: func(context.Context) (int64, error) {
			return 17, nil
		},
	}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe all: %v", err)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscription_barrier"}`)); err != nil {
		t.Fatalf("send subscription barrier: %v", err)
	}

	var ready protocol.FeedSubscriptionsReadyMessage
	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	messageType, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read subscription acknowledgement: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("subscription acknowledgement message type = %v", messageType)
	}
	if err := json.Unmarshal(data, &ready); err != nil {
		t.Fatalf("decode subscription acknowledgement: %v", err)
	}
	if ready.Type != "subscriptions_ready" || ready.Version != 17 {
		t.Fatalf("subscription acknowledgement = %+v", ready)
	}
	if !hub.HasSubscription(Subscription{Filter: protocol.FeedFilterAll}) {
		t.Fatal("subscription acknowledgement arrived before the subscription was installed")
	}
}

func TestWebsocketFeedClosesWithInternalErrorWhenSubscriptionWatermarkFails(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		CurrentVersion: func(context.Context) (int64, error) {
			return 0, errors.New("database unavailable")
		},
	}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscription_barrier"}`)); err != nil {
		t.Fatalf("send subscription barrier: %v", err)
	}

	expectFeedClosedWithStatus(t, conn, websocket.StatusInternalError)
}

func TestWebsocketFeedUnsubscribeStopsDelivery(t *testing.T) {
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
	hub.Publish(entityEvent("create", "asset-before-unsubscribe", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-before-unsubscribe" {
		t.Fatalf("unexpected event before unsubscribe: %+v", event)
	}

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"unsubscribe","filter":"all"}`)); err != nil {
		t.Fatalf("unsubscribe all: %v", err)
	}
	waitForNoSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
	hub.Publish(entityEvent("create", "asset-after-unsubscribe", 2, "asset"))
	assertNoFeedEvent(t, conn)
}

func TestWebsocketFeedAllowsMultipleSubscriptions(t *testing.T) {
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterID, ResourceType: protocol.ResourceTypeEntity, ID: "asset-specific"})

	hub.Publish(entityEvent("create", "asset-specific", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-specific" || event.Version != 1 {
		t.Fatalf("unexpected specific event: %+v", event)
	}
	hub.Publish(taskEvent("create", "task-from-all", 2, "asset-specific", "pending"))
	readFeedEvent(t, conn, &event)
	if event.ID != "task-from-all" || event.Version != 2 {
		t.Fatalf("unexpected all-subscription event: %+v", event)
	}
}

func TestWebsocketFeedDuplicateSubscriptionsAreIdempotent(t *testing.T) {
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
	hub.Publish(entityEvent("create", "asset-duplicate-sub", 1, "asset"))
	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.ID != "asset-duplicate-sub" {
		t.Fatalf("unexpected duplicate-subscription event: %+v", event)
	}
	assertNoFeedEvent(t, conn)
}

func TestWebsocketFeedFirstMessageAuthWhenEnabled(t *testing.T) {
	hub := NewHub(Options{})
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
		Filter:       protocol.FeedFilterType,
		ResourceType: protocol.ResourceTypeTask,
	})
	hub.Publish(taskEvent("create", "task-auth", 1, "asset-1", "pending"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 1 || event.ResourceType != protocol.ResourceTypeTask {
		t.Fatalf("unexpected authenticated feed event: %+v", event)
	}
}

func TestWebsocketFeedFirstMessageAuthUsesAPIKeyValidator(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
			APIKeyValidator: func(_ context.Context, apiKey string) (bool, error) {
				return apiKey == "managed-secret", nil
			},
		},
	}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"managed-secret"}`)); err != nil {
		t.Fatalf("auth feed with managed key: %v", err)
	}
	readHandshake(t, conn)
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"type","resource_type":"task"}`)); err != nil {
		t.Fatalf("subscribe task type: %v", err)
	}
	waitForSubscription(t, hub, Subscription{
		Filter:       protocol.FeedFilterType,
		ResourceType: protocol.ResourceTypeTask,
	})
	hub.Publish(taskEvent("create", "task-managed-auth", 1, "asset-1", "pending"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 1 || event.ResourceType != protocol.ResourceTypeTask {
		t.Fatalf("unexpected managed-key feed event: %+v", event)
	}
}

func TestWebsocketFeedFirstMessageAuthClosesWhenAPIKeyValidatorErrors(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
			APIKeyValidator: func(context.Context, string) (bool, error) {
				return false, errors.New("validator unavailable")
			},
			AuthTimeout: 2 * time.Second,
		},
	}.ServeHTTP))
	defer server.Close()

	conn := dialFeed(t, server.URL)
	defer func() {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"auth","api_key":"managed-secret"}`)); err != nil {
		t.Fatalf("auth feed with managed key: %v", err)
	}
	expectFeedClosedWithStatus(t, conn, websocket.StatusPolicyViolation)
}

func TestWebsocketFeedRejectsDeniedCrossOriginBeforeUpgrade(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	server := httptest.NewServer(http.HandlerFunc(Server{
		Hub: hub,
		Config: ServerConfig{
			AllowedOrigin: func(origin string) bool {
				return false
			},
		},
	}.ServeHTTP))
	defer server.Close()

	conn, response, err := websocket.Dial(context.Background(), websocketURL(server.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Origin": []string{"https://extra.pr-123.atlas-je0.pages.dev"},
		},
	})
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
	if response != nil && response.Body != nil {
		defer func() {
			_ = response.Body.Close()
		}()
	}
	if err == nil {
		t.Fatal("expected cross-origin feed dial to be rejected")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("response status = %v, want %d", responseStatus(response), http.StatusUnauthorized)
	}
}

func TestWebsocketFeedRejectsAuthEnabledWithoutAPIKey(t *testing.T) {
	hub := NewHub(Options{})
	defer hub.Close()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	Server{
		Hub: hub,
		Config: ServerConfig{
			EnableAPIAuth: true,
		},
	}.ServeHTTP(rec, req)

	assertFeedProtocolError(t, rec, http.StatusServiceUnavailable, protocol.ErrorCodeFeedUnavailable, "feed API key is not configured")
}

func TestWebsocketFeedFirstMessageAuthRejectsMissingFirstFrame(t *testing.T) {
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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
	hub := NewHub(Options{})
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

	assertFeedProtocolError(t, rec, http.StatusServiceUnavailable, protocol.ErrorCodeFeedUnavailable, "feed API key is not configured")
}

func TestWebsocketFeedRejectsMissingHubWithProtocolError(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	Server{}.ServeHTTP(rec, req)

	assertFeedProtocolError(t, rec, http.StatusServiceUnavailable, protocol.ErrorCodeFeedUnavailable, "feed hub is not configured")
}

func TestWebsocketFeedFirstMessageAuthRejectsAuthAfterHandshake(t *testing.T) {
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
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
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})
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
	hub := NewHub(Options{})
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
	waitForSubscription(t, hub, Subscription{Filter: protocol.FeedFilterAll})

	hub.Close()

	expectFeedClosedWithStatus(t, conn, websocket.StatusInternalError)
}

func TestWebsocketFeedRejectsBinaryFrame(t *testing.T) {
	hub := NewHub(Options{})
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

func responseStatus(response *http.Response) int {
	if response == nil {
		return 0
	}
	return response.StatusCode
}

func assertFeedProtocolError(t *testing.T, rec *httptest.ResponseRecorder, status int, code protocol.ErrorCode, message string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d", rec.Code, status)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var response protocol.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode protocol error response: %v; body = %q", err, rec.Body.String())
	}
	if response.Success || response.ErrorCode != code || response.Message != message {
		t.Fatalf("protocol error response = %+v, want success=false code=%s message=%q", response, code, message)
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
