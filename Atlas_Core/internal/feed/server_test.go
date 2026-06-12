package feed

import (
	"context"
	"encoding/json"
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
	time.Sleep(50 * time.Millisecond)

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"action":"subscribe","filter":"all"}`)); err != nil {
		t.Fatalf("subscribe all: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	hub.Publish(entityEvent("create", "asset-after-subscribe", 2, "asset"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 2 || event.ID != "asset-after-subscribe" {
		t.Fatalf("unexpected event after subscribe: %+v", event)
	}
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
	time.Sleep(50 * time.Millisecond)
	hub.Publish(taskEvent("create", "task-auth", 1, "", "asset-1", "pending"))

	var event protocol.FeedEvent
	readFeedEvent(t, conn, &event)
	if event.Version != 1 || event.ResourceType != protocol.ResourceTypeTask {
		t.Fatalf("unexpected authenticated feed event: %+v", event)
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
	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
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

func websocketURL(url string) string {
	return "ws" + strings.TrimPrefix(url, "http")
}
