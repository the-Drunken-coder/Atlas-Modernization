package feed

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

var errSubscriptionWatermark = errors.New("feed subscription watermark unavailable")

const (
	defaultAuthTimeout       = 5 * time.Second
	defaultWriteTimeout      = 5 * time.Second
	defaultKeepaliveInterval = 30 * time.Second
)

type ServerConfig struct {
	EnableAPIAuth     bool
	APIKey            string
	APIKeyValidator   func(context.Context, string) (bool, error)
	SkipOriginCheck   bool
	AllowedOrigin     func(origin string) bool
	AuthTimeout       time.Duration
	WriteTimeout      time.Duration
	KeepaliveInterval time.Duration
}

type Server struct {
	Hub            *Hub
	Config         ServerConfig
	CurrentVersion func(context.Context) (int64, error)
}

func (s Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.Hub == nil {
		writeProtocolError(w, r, http.StatusServiceUnavailable, "feed hub is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	if s.Config.EnableAPIAuth && strings.TrimSpace(s.Config.APIKey) == "" && s.Config.APIKeyValidator == nil {
		zerolog.Ctx(r.Context()).Error().Msg("Atlas feed server has auth enabled without an API key")
		writeProtocolError(w, r, http.StatusServiceUnavailable, "feed API key is not configured", protocol.ErrorCodeFeedUnavailable)
		return
	}
	if !s.Config.SkipOriginCheck && !s.originAllowed(r) {
		writeProtocolError(w, r, http.StatusUnauthorized, "unauthorized", protocol.ErrorCodeUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	closeStatus := websocket.StatusNormalClosure
	closeReason := "feed closed"
	closeWith := func(status websocket.StatusCode, reason string) {
		closeStatus = status
		closeReason = reason
	}
	logger := zerolog.Ctx(r.Context())

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer func() {
		_ = conn.Close(closeStatus, closeReason)
	}()

	client := s.Hub.NewClient()
	defer client.Close()

	if s.Config.EnableAPIAuth {
		if err := s.readAuthFrame(ctx, conn); err != nil {
			logger.Warn().Err(err).Msg("Atlas feed authentication failed")
			closeWith(websocket.StatusPolicyViolation, "feed authentication failed")
			return
		}
	}
	if err := s.writeHandshake(ctx, conn); err != nil {
		closeWith(websocket.StatusInternalError, "feed handshake failed")
		return
	}

	errCh := make(chan error, 1)
	go func() {
		if err := s.writeLoop(ctx, conn, client); err != nil {
			select {
			case errCh <- err:
			default:
			}
		}
	}()
	readCh := make(chan feedReadResult, 1)
	go s.readLoop(ctx, conn, readCh)

	for {
		select {
		case <-errCh:
			closeWith(websocket.StatusInternalError, "feed write error")
			return
		case result := <-readCh:
			if result.err != nil {
				switch websocket.CloseStatus(result.err) {
				case websocket.StatusNormalClosure, websocket.StatusGoingAway:
					closeWith(websocket.StatusNormalClosure, "feed closed")
				default:
					closeWith(websocket.StatusInternalError, "feed read error")
				}
				cancel()
				return
			}
			if result.messageType != websocket.MessageText {
				closeWith(websocket.StatusUnsupportedData, "feed expects text JSON frames")
				return
			}
			if err := s.handleClientFrame(ctx, client, result.data); err != nil {
				logger.Warn().Err(err).Msg("Atlas feed rejected client frame")
				if errors.Is(err, errSubscriptionWatermark) {
					closeWith(websocket.StatusInternalError, "feed subscription watermark failed")
					return
				}
				closeWith(websocket.StatusPolicyViolation, "invalid client frame")
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (s Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if strings.EqualFold(r.Host, parsed.Host) {
		return true
	}
	return s.Config.AllowedOrigin != nil && s.Config.AllowedOrigin(origin)
}

func writeProtocolError(w http.ResponseWriter, r *http.Request, status int, message string, code protocol.ErrorCode) {
	response, err := protocol.NewErrorResponse(message, code)
	if err != nil {
		zerolog.Ctx(r.Context()).Error().Err(err).Msg("build feed protocol error response")
		response = protocol.ErrorResponse{Success: false, Message: message, ErrorCode: code}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		zerolog.Ctx(r.Context()).Error().Err(err).Msg("write feed protocol error response")
	}
}

type feedReadResult struct {
	messageType websocket.MessageType
	data        []byte
	err         error
}

func (s Server) readLoop(ctx context.Context, conn *websocket.Conn, readCh chan<- feedReadResult) {
	for {
		messageType, data, err := conn.Read(ctx)
		select {
		case readCh <- feedReadResult{messageType: messageType, data: data, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
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

	readCtx, cancelRead := context.WithCancel(ctx)
	readCh := make(chan feedReadResult, 1)
	go func() {
		messageType, data, err := conn.Read(readCtx)
		readCh <- feedReadResult{messageType: messageType, data: data, err: err}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var result feedReadResult
	select {
	case result = <-readCh:
		cancelRead()
	case <-timer.C:
		// Let ServeHTTP send the policy close frame before canceling the pending
		// read; canceling here turns the client-observed close into EOF.
		go func() {
			<-ctx.Done()
			cancelRead()
		}()
		return fmt.Errorf("feed auth frame not received")
	case <-ctx.Done():
		cancelRead()
		return fmt.Errorf("feed auth frame not received")
	}
	if result.err != nil {
		return fmt.Errorf("feed auth frame not received")
	}
	if result.messageType != websocket.MessageText {
		return fmt.Errorf("feed auth frame must be text JSON")
	}

	var payload map[string]any
	if err := json.Unmarshal(result.data, &payload); err != nil {
		return fmt.Errorf("feed auth frame is invalid JSON")
	}
	if errors := protocol.ValidateFeedAuthMessage(payload); len(errors) > 0 {
		return fmt.Errorf("feed auth frame is invalid: %s", strings.Join(errors, "; "))
	}
	var message protocol.FeedAuthMessage
	if err := json.Unmarshal(result.data, &message); err != nil {
		return fmt.Errorf("feed auth frame is invalid JSON")
	}
	valid, err := s.validAPIKey(ctx, message.APIKey)
	if err != nil {
		return fmt.Errorf("feed API key validation failed: %w", err)
	}
	if !valid {
		return fmt.Errorf("feed API key rejected")
	}
	return nil
}

func (s Server) handleClientFrame(ctx context.Context, client *Client, data []byte) error {
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
	case string(protocol.FeedActionSubscriptionBarrier):
		if errors := protocol.ValidateFeedSubscriptionBarrierMessage(json.RawMessage(data)); len(errors) > 0 {
			return fmt.Errorf("feed subscription barrier is invalid: %s", strings.Join(errors, "; "))
		}
		version := int64(0)
		if s.CurrentVersion != nil {
			var err error
			version, err = s.CurrentVersion(ctx)
			if err != nil {
				return fmt.Errorf("%w: %v", errSubscriptionWatermark, err)
			}
		}
		if !client.SubscriptionsReady(version) {
			return fmt.Errorf("feed subscription barrier could not be acknowledged")
		}
		return nil
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

func (s Server) writeLoop(ctx context.Context, conn *websocket.Conn, client *Client) error {
	keepalive := s.Config.KeepaliveInterval
	if keepalive <= 0 {
		keepalive = defaultKeepaliveInterval
	}
	ticker := time.NewTicker(keepalive)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-client.Events():
			if !ok {
				return fmt.Errorf("feed client closed")
			}
			if err := s.writeJSONFrame(ctx, conn, event.Event); err != nil {
				return err
			}
		case control, ok := <-client.Controls():
			if !ok {
				return fmt.Errorf("feed client closed")
			}
			if err := s.writeJSONFrame(ctx, conn, control); err != nil {
				return err
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, s.writeTimeout())
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}

func (s Server) writeJSONFrame(ctx context.Context, conn *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, s.writeTimeout())
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, data)
}

func (s Server) writeTimeout() time.Duration {
	if s.Config.WriteTimeout > 0 {
		return s.Config.WriteTimeout
	}
	return defaultWriteTimeout
}

func (s Server) validAPIKey(ctx context.Context, provided string) (bool, error) {
	if constantTimeEqual(provided, s.Config.APIKey) {
		return true, nil
	}
	if s.Config.APIKeyValidator == nil {
		return false, nil
	}
	return s.Config.APIKeyValidator(ctx, provided)
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
