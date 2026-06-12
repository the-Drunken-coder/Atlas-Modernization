package feed

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const (
	defaultAuthTimeout       = 5 * time.Second
	defaultWriteTimeout      = 5 * time.Second
	defaultKeepaliveInterval = 30 * time.Second
)

type ServerConfig struct {
	EnableAPIAuth     bool
	APIKey            string
	OriginPatterns    []string
	AuthTimeout       time.Duration
	WriteTimeout      time.Duration
	KeepaliveInterval time.Duration
}

type Server struct {
	Hub    *Hub
	Config ServerConfig
}

func (s Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.Hub == nil {
		http.Error(w, "feed hub is not configured", http.StatusServiceUnavailable)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.Config.OriginPatterns,
	})
	if err != nil {
		return
	}
	defer func() {
		_ = conn.Close(websocket.StatusInternalError, "feed closed unexpectedly")
	}()

	client := s.Hub.NewClient()
	defer client.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if s.Config.EnableAPIAuth {
		if err := s.readAuthFrame(ctx, conn); err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
	}
	if err := s.writeHandshake(ctx, conn); err != nil {
		return
	}

	errCh := make(chan error, 1)
	go s.writeLoop(ctx, conn, client, errCh)

	for {
		select {
		case err := <-errCh:
			if err != nil {
				return
			}
		default:
		}

		messageType, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText {
			_ = conn.Close(websocket.StatusUnsupportedData, "feed expects text JSON frames")
			return
		}
		if err := s.handleClientFrame(client, data); err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
	}
}

func (s Server) writeHandshake(ctx context.Context, conn *websocket.Conn) error {
	data, err := json.Marshal(protocol.FeedHandshakeMessage{
		Type:             "hello",
		ProtocolRevision: protocol.ProtocolRevision,
	})
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, s.writeTimeout())
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, data)
}

func (s Server) readAuthFrame(ctx context.Context, conn *websocket.Conn) error {
	timeout := s.Config.AuthTimeout
	if timeout <= 0 {
		timeout = defaultAuthTimeout
	}
	authCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	messageType, data, err := conn.Read(authCtx)
	if err != nil {
		return fmt.Errorf("feed auth frame not received")
	}
	if messageType != websocket.MessageText {
		return fmt.Errorf("feed auth frame must be text JSON")
	}

	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("feed auth frame is invalid JSON")
	}
	if errors := protocol.ValidateFeedAuthMessage(payload); len(errors) > 0 {
		return fmt.Errorf("feed auth frame is invalid")
	}
	var msg protocol.FeedAuthMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return fmt.Errorf("feed auth frame is invalid")
	}
	if !constantTimeEqual(msg.APIKey, s.Config.APIKey) {
		return fmt.Errorf("feed API key rejected")
	}
	return nil
}

func (s Server) handleClientFrame(client *Client, data []byte) error {
	var action struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(data, &action); err != nil {
		return fmt.Errorf("feed frame is invalid JSON")
	}
	switch action.Action {
	case string(protocol.FeedActionAuth):
		if s.Config.EnableAPIAuth {
			return fmt.Errorf("feed auth frame must be first")
		}
		return nil
	case string(protocol.FeedActionSubscribe):
		return handleSubscriptionFrame(client, data, true)
	case string(protocol.FeedActionUnsubscribe):
		return handleSubscriptionFrame(client, data, false)
	default:
		return fmt.Errorf("unknown feed action %q", action.Action)
	}
}

func handleSubscriptionFrame(client *Client, data []byte, subscribe bool) error {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("feed subscription frame is invalid JSON")
	}
	var errors []string
	if subscribe {
		errors = protocol.ValidateFeedSubscribeMessage(payload)
	} else {
		errors = protocol.ValidateFeedUnsubscribeMessage(payload)
	}
	if len(errors) > 0 {
		return fmt.Errorf("feed subscription frame is invalid: %s", strings.Join(errors, "; "))
	}

	var msg protocol.FeedSubscriptionMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return fmt.Errorf("feed subscription frame is invalid")
	}
	sub, err := SubscriptionFromMessage(msg)
	if err != nil {
		return err
	}
	if subscribe {
		client.Subscribe(sub)
	} else {
		client.Unsubscribe(sub)
	}
	return nil
}

func (s Server) writeLoop(ctx context.Context, conn *websocket.Conn, client *Client, errCh chan<- error) {
	keepalive := s.Config.KeepaliveInterval
	if keepalive <= 0 {
		keepalive = defaultKeepaliveInterval
	}
	ticker := time.NewTicker(keepalive)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-client.Events():
			if !ok {
				errCh <- fmt.Errorf("feed client closed")
				_ = conn.Close(websocket.StatusPolicyViolation, "feed client closed")
				return
			}
			data, err := json.Marshal(event.Event)
			if err != nil {
				errCh <- err
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, s.writeTimeout())
			err = conn.Write(writeCtx, websocket.MessageText, data)
			cancel()
			if err != nil {
				errCh <- err
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, s.writeTimeout())
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				errCh <- err
				return
			}
		}
	}
}

func (s Server) writeTimeout() time.Duration {
	if s.Config.WriteTimeout > 0 {
		return s.Config.WriteTimeout
	}
	return defaultWriteTimeout
}

func constantTimeEqual(provided, expected string) bool {
	provided = strings.TrimSpace(provided)
	expected = strings.TrimSpace(expected)
	if expected == "" {
		return false
	}
	pH := sha256.Sum256([]byte(provided))
	eH := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(pH[:], eH[:]) == 1
}
