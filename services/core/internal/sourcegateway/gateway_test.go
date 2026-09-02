package sourcegateway

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestGatewayPreservesBinaryTuplesAndEncodesDecodedURLOnce(t *testing.T) {
	var outbound *http.Request
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		outbound = request.Clone(request.Context())
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, []byte{0, 1, 255}) {
			t.Fatalf("unexpected request body %v", body)
		}
		return &http.Response{
			StatusCode: 207,
			Header: http.Header{
				"X-Result":   {"one", "two"},
				"Set-Cookie": {"secret=true"},
				"Connection": {"x-hop"},
				"X-Hop":      {"hidden"},
			},
			Body: io.NopCloser(bytes.NewReader([]byte{9, 0, 8})),
		}, nil
	})}
	config := testConnectorConfig()
	config.Routes[0].PathPrefix = "/"
	config.Routes[0].AllowedQueryNames = []string{"tag", "space"}
	config.Routes[0].AllowedRequestHeaders = []string{"x-request"}
	config.Routes[0].AllowedResponseHeaders = []string{"x-result", "x-hop"}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	body := base64.StdEncoding.EncodeToString([]byte{0, 1, 255})
	request := ConnectorRequest{
		Method: "GET", Path: "/literal%/café", Query: []HeaderTuple{{"tag", "one"}, {"tag", "two"}, {"space", "a b"}},
		Headers: []HeaderTuple{{"x-request", "a"}, {"x-request", "b"}}, BodyBase64: &body,
	}
	response, _, _, gatewayErr := gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if gatewayErr != nil {
		t.Fatal(gatewayErr)
	}
	if got := outbound.URL.EscapedPath(); got != "/literal%25/caf%C3%A9" {
		t.Fatalf("unexpected encoded path %s", got)
	}
	if got := outbound.URL.RawQuery; got != "tag=one&tag=two&space=a%20b" {
		t.Fatalf("unexpected query %s", got)
	}
	if values := outbound.Header.Values("X-Request"); len(values) != 2 || values[0] != "a" || values[1] != "b" {
		t.Fatalf("repeated request headers lost: %v", values)
	}
	if response.Status != 207 || response.BodyBase64 != "CQAI" {
		t.Fatalf("unexpected response %+v", response)
	}
	if len(response.Headers) != 2 || response.Headers[0] != (HeaderTuple{"x-result", "one"}) || response.Headers[1] != (HeaderTuple{"x-result", "two"}) {
		t.Fatalf("response filtering failed: %v", response.Headers)
	}
}

func TestGatewayHandlerMapsFailuresAndCachesSafeResponses(t *testing.T) {
	var calls atomic.Int32
	var logs bytes.Buffer
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	})}
	config := testConnectorConfig()
	config.Routes[0].Cache.TTLMS = 10_000
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client, Logger: zerolog.New(&logs)})
	if err != nil {
		t.Fatal(err)
	}
	input := `{"method":"GET","path":"/fixture","query":[["key","alpha"]],"headers":[],"body_base64":null}`
	for range 2 {
		request := httptest.NewRequest(http.MethodPost, "/connectors/reference/requests", strings.NewReader(input))
		request.Header.Set("Content-Type", "application/json")
		writer := httptest.NewRecorder()
		gateway.Handler().ServeHTTP(writer, request)
		if writer.Code != 200 {
			t.Fatalf("request failed: %d %s", writer.Code, writer.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("expected cache hit, got %d upstream calls", calls.Load())
	}

	request := httptest.NewRequest(http.MethodPost, "/connectors/missing/requests", strings.NewReader(input))
	request.Header.Set("Content-Type", "application/json")
	writer := httptest.NewRecorder()
	gateway.Handler().ServeHTTP(writer, request)
	if writer.Code != 404 || writer.Body.String() != "{\"code\":\"unknown_connector\"}\n" {
		t.Fatalf("unexpected failure response %d %s", writer.Code, writer.Body.String())
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	var event map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &event); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"connector_id", "outcome", "upstream_status", "duration_ms", "retries", "cache_result"} {
		if _, present := event[field]; !present {
			t.Fatalf("structured request log is missing %s: %v", field, event)
		}
	}
}

func TestGatewayDoesNotReplayResponsesWhenCacheIsDisabled(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		body := `{"remark":"runtime error: Query timed out."}`
		if calls.Add(1) > 1 {
			body = `{"elements":[]}`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	config := testConnectorConfig()
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectorRequest{Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{}}
	first, firstAttempts, firstCache, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure != nil || firstAttempts != 1 || firstCache != "bypass" {
		t.Fatalf("first response=%+v attempts=%d cache=%s failure=%v", first, firstAttempts, firstCache, failure)
	}
	second, secondAttempts, secondCache, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure != nil || secondAttempts != 1 || secondCache != "bypass" || calls.Load() != 2 {
		t.Fatalf("second response=%+v attempts=%d cache=%s calls=%d failure=%v", second, secondAttempts, secondCache, calls.Load(), failure)
	}
	if first.BodyBase64 == second.BodyBase64 {
		t.Fatal("second request replayed the first response")
	}
}

func TestGatewayDoesNotCacheAnExhaustedRetryStatus(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		status := http.StatusServiceUnavailable
		body := "retry"
		if calls.Add(1) > 2 {
			status = http.StatusOK
			body = "recovered"
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	config := testConnectorConfig()
	config.Routes[0].Cache.TTLMS = 10_000
	config.Routes[0].Retry = RetryRule{MaxRetries: 1, Statuses: []int{http.StatusServiceUnavailable}}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectorRequest{Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{}}
	response, attempts, cacheResult, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure != nil || attempts != 2 || response.Status != http.StatusServiceUnavailable || cacheResult != "miss" {
		t.Fatalf("unexpected exhausted retry response=%+v attempts=%d cache=%s failure=%v", response, attempts, cacheResult, failure)
	}
	response, _, cacheResult, failure = gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure != nil || response.Status != http.StatusOK || cacheResult != "stored" || calls.Load() != 3 {
		t.Fatalf("recovery response=%+v cache=%s calls=%d failure=%v", response, cacheResult, calls.Load(), failure)
	}
}

func TestGatewayDoesNotCacheTransientHTTPResponsesWithoutRetries(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				responseStatus := status
				if calls.Add(1) > 1 {
					responseStatus = http.StatusOK
				}
				return &http.Response{
					StatusCode: responseStatus,
					Header:     http.Header{},
					Body:       io.NopCloser(strings.NewReader(http.StatusText(responseStatus))),
				}, nil
			})}
			config := testConnectorConfig()
			config.Routes[0].Cache.TTLMS = 10_000
			gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client})
			if err != nil {
				t.Fatal(err)
			}
			request := ConnectorRequest{Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{}}
			first, _, cacheResult, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
			if failure != nil || first.Status != status || cacheResult != "miss" {
				t.Fatalf("transient response=%+v cache=%s failure=%v", first, cacheResult, failure)
			}
			second, _, cacheResult, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
			if failure != nil || second.Status != http.StatusOK || cacheResult != "stored" || calls.Load() != 2 {
				t.Fatalf("recovery response=%+v cache=%s calls=%d failure=%v", second, cacheResult, calls.Load(), failure)
			}
		})
	}
}

func TestGatewayBoundsRetriesCircuitAndCancellation(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, context.DeadlineExceeded
	})}
	config := testConnectorConfig()
	config.Limits.TimeoutMS = 20
	config.CircuitBreaker.Failures = 1
	config.Routes[0].Retry = RetryRule{MaxRetries: 1, Failures: []string{string(FailureUpstreamTimeout)}}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectorRequest{Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{}}
	_, attempts, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure == nil || failure.code != FailureUpstreamTimeout || attempts != 2 {
		t.Fatalf("unexpected retry result attempts=%d failure=%v", attempts, failure)
	}
	_, _, _, failure = gateway.execute(context.Background(), gateway.connectors["reference"], request)
	if failure == nil || failure.code != FailureCircuitOpen {
		t.Fatalf("expected open circuit, got %v", failure)
	}

	cancelConfig := testConnectorConfig()
	cancelGateway, err := New(Config{Connectors: []ConnectorConfig{cancelConfig}}, Options{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, attempts, _, failure = cancelGateway.execute(ctx, cancelGateway.connectors["reference"], request)
	if failure == nil || failure.code != failureRequestCanceled || attempts != 0 || !errors.Is(failure.err, context.Canceled) {
		t.Fatalf("expected propagated cancellation, got %v", failure)
	}
}

func TestAddressPolicyRejectsPrivateLoopbackAndLinkLocalByDefault(t *testing.T) {
	for _, address := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.1.1", "::1", "fe80::1",
		"0.1.2.3", "100.64.0.1", "192.0.0.1", "192.88.99.1", "198.18.0.1", "240.0.0.1", "255.255.255.255", "fec0::1",
	} {
		parsed := netip.MustParseAddr(address)
		if addressAllowed(parsed, EgressPolicy{}) {
			t.Fatalf("expected %s to be rejected", address)
		}
	}
	if !addressAllowed(netip.MustParseAddr("127.0.0.1"), EgressPolicy{AllowLoopback: true}) ||
		!addressAllowed(netip.MustParseAddr("10.0.0.1"), EgressPolicy{AllowPrivate: true}) ||
		!addressAllowed(netip.MustParseAddr("100.64.0.1"), EgressPolicy{AllowPrivate: true}) ||
		!addressAllowed(netip.MustParseAddr("169.254.1.1"), EgressPolicy{AllowLinkLocal: true}) {
		t.Fatal("explicit egress allowances were not honored")
	}
}

func TestAddressPolicyClassifiesIPv4TranslationDestinations(t *testing.T) {
	for _, address := range []string{
		"64:ff9b::7f00:1",
		"64:ff9b::a00:1",
		"64:ff9b::a9fe:a9fe",
		"64:ff9b:1::7f00:1",
	} {
		if addressAllowed(netip.MustParseAddr(address), EgressPolicy{}) {
			t.Fatalf("expected translated address %s to be rejected", address)
		}
	}
	if !addressAllowed(netip.MustParseAddr("64:ff9b::808:808"), EgressPolicy{}) {
		t.Fatal("expected a translated public address to be allowed")
	}
	if !addressAllowed(netip.MustParseAddr("64:ff9b::7f00:1"), EgressPolicy{AllowLoopback: true}) ||
		!addressAllowed(netip.MustParseAddr("64:ff9b::a00:1"), EgressPolicy{AllowPrivate: true}) ||
		!addressAllowed(netip.MustParseAddr("64:ff9b::a9fe:a9fe"), EgressPolicy{AllowLinkLocal: true}) {
		t.Fatal("translated destinations did not honor explicit egress allowances")
	}
	if addressAllowed(netip.MustParseAddr("64:ff9b:1::808:808"), EgressPolicy{
		AllowPrivate: true, AllowLoopback: true, AllowLinkLocal: true,
	}) {
		t.Fatal("expected an ambiguous local-use translation address to be rejected")
	}
}

func TestCacheKeySeparatesRequestSections(t *testing.T) {
	query := preparedRequest{method: "GET", path: "/fixture", query: []HeaderTuple{{"a", "b"}}}
	header := preparedRequest{method: "GET", path: "/fixture", headers: []HeaderTuple{{"a", "b"}}}
	body := preparedRequest{method: "GET", path: "/fixture", body: []byte("a\x00b\x00")}
	keys := map[string]bool{
		requestCacheKey("reference", query):  true,
		requestCacheKey("reference", header): true,
		requestCacheKey("reference", body):   true,
	}
	if len(keys) != 3 {
		t.Fatalf("cache key sections collided: %v", keys)
	}
}

func TestQueuedRequestRechecksCircuitAfterConcurrencyWait(t *testing.T) {
	var calls atomic.Int32
	passedInitialCircuitCheck := make(chan struct{})
	var clockCalls atomic.Int32
	config := testConnectorConfig()
	config.Limits.MaxConcurrency = 1
	config.CircuitBreaker.Failures = 1
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{
		Now: func() time.Time {
			if clockCalls.Add(1) == 1 {
				close(passedInitialCircuitCheck)
			}
			return time.Now()
		},
		Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return nil, errors.New("offline")
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := gateway.connectors["reference"]
	connector.semaphore <- struct{}{}
	result := make(chan *gatewayError, 1)
	go func() {
		_, _, _, failure := gateway.execute(context.Background(), connector, ConnectorRequest{
			Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
		})
		result <- failure
	}()
	<-passedInitialCircuitCheck
	connector.recordFailure(time.Now())
	<-connector.semaphore
	select {
	case failure := <-result:
		if failure == nil || failure.code != FailureCircuitOpen || calls.Load() != 0 {
			t.Fatalf("queued request = %v, upstream calls = %d", failure, calls.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("queued request did not resume")
	}
}

func TestGatewayAdmissionTimeoutMakesNoUpstreamAttempt(t *testing.T) {
	for _, test := range []struct {
		name  string
		block func(*connector)
	}{
		{
			name: "concurrency",
			block: func(connector *connector) {
				connector.semaphore <- struct{}{}
			},
		},
		{
			name: "rate limit",
			block: func(connector *connector) {
				connector.nextRequest = time.Now().Add(time.Second)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			config := testConnectorConfig()
			config.Limits.TimeoutMS = 20
			if test.name == "concurrency" {
				config.Limits.MaxConcurrency = 1
			} else {
				config.Rate.RequestsPerSecond = 1
			}
			gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{
				Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: http.NoBody}, nil
				})},
			})
			if err != nil {
				t.Fatal(err)
			}
			test.block(gateway.connectors["reference"])

			_, attempts, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
				Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
			})
			if failure == nil || failure.code != FailureAdmissionTimeout || attempts != 0 || calls.Load() != 0 {
				t.Fatalf("attempts=%d calls=%d failure=%v", attempts, calls.Load(), failure)
			}
			writer := httptest.NewRecorder()
			writeFailure(writer, failure)
			if writer.Code != http.StatusServiceUnavailable || writer.Body.String() != `{"code":"admission_timeout"}`+"\n" {
				t.Fatalf("admission response=%d %s", writer.Code, writer.Body.String())
			}
		})
	}
}

func TestRateLimitCountsRetriesAndCanceledWaitersDoNotReserveCapacity(t *testing.T) {
	now := time.Now()
	config := testConnectorConfig()
	config.Rate.RequestsPerSecond = 1000
	config.Routes[0].Retry = RetryRule{MaxRetries: 2, Statuses: []int{http.StatusServiceUnavailable}}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{
		Now: func() time.Time { return now },
		Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("retry"))}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	connector := gateway.connectors["reference"]
	_, attempts, _, failure := gateway.execute(context.Background(), connector, ConnectorRequest{
		Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
	})
	if failure != nil || attempts != 3 || !connector.nextRequest.Equal(now.Add(3*time.Millisecond)) {
		t.Fatalf("attempts=%d next=%s failure=%v", attempts, connector.nextRequest, failure)
	}

	reserved := now.Add(time.Hour)
	connector.nextRequest = reserved
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := connector.waitForRate(ctx, func() time.Time { return now }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled wait = %v", err)
	}
	if !connector.nextRequest.Equal(reserved) {
		t.Fatalf("canceled waiter moved reservation to %s", connector.nextRequest)
	}

	connector.nextRequest = now
	if err := connector.waitForRate(ctx, func() time.Time { return now }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled immediate reservation = %v", err)
	}
	if !connector.nextRequest.Equal(now) {
		t.Fatalf("canceled waiter reserved immediate capacity until %s", connector.nextRequest)
	}

	duringClockContext, cancelDuringClock := context.WithCancel(context.Background())
	connector.nextRequest = now
	if err := connector.waitForRate(duringClockContext, func() time.Time {
		cancelDuringClock()
		return now
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation during rate admission = %v", err)
	}
	if !connector.nextRequest.Equal(now) {
		t.Fatalf("cancellation during rate admission reserved capacity until %s", connector.nextRequest)
	}
}

type contextBody struct{ ctx context.Context }

func (b contextBody) Read([]byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

func (contextBody) Close() error { return nil }

func TestGatewayClassifiesBodyDeadlineAndDoesNotRetry(t *testing.T) {
	var calls atomic.Int32
	config := testConnectorConfig()
	config.Limits.TimeoutMS = 20
	config.Routes[0].Retry = RetryRule{MaxRetries: 3, Failures: []string{string(FailureUpstreamTimeout)}}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: contextBody{ctx: request.Context()}}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	_, attempts, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
		Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
	})
	if failure == nil || failure.code != FailureUpstreamTimeout || attempts != 1 || calls.Load() != 1 {
		t.Fatalf("attempts=%d calls=%d failure=%v", attempts, calls.Load(), failure)
	}
}

func TestDefaultTransportPreservesCompressedBytesAndAddsNoImplicitHeaders(t *testing.T) {
	var compressed bytes.Buffer
	zipper := gzip.NewWriter(&compressed)
	_, _ = zipper.Write([]byte("payload"))
	_ = zipper.Close()
	var acceptEncoding, userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acceptEncoding = r.Header.Get("Accept-Encoding")
		userAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(compressed.Bytes())
	}))
	t.Cleanup(server.Close)
	config := testConnectorConfig()
	config.Origin = server.URL
	config.Egress.AllowLoopback = true
	config.Routes[0].AllowedResponseHeaders = []string{"content-encoding"}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	response, _, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
		Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
	})
	if failure != nil {
		t.Fatal(failure)
	}
	body, err := base64.StdEncoding.DecodeString(response.BodyBase64)
	if err != nil || !bytes.Equal(body, compressed.Bytes()) || acceptEncoding != "" || userAgent != "" {
		t.Fatalf("body preserved=%t accept-encoding=%q user-agent=%q error=%v", bytes.Equal(body, compressed.Bytes()), acceptEncoding, userAgent, err)
	}
}

func TestDefaultTransportPreservesAllowedUserAgent(t *testing.T) {
	var userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	config := testConnectorConfig()
	config.Origin = server.URL
	config.Egress.AllowLoopback = true
	config.Routes[0].AllowedRequestHeaders = []string{"user-agent"}
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
		Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{{"user-agent", "Atlas Plugin/1"}},
	})
	if failure != nil {
		t.Fatal(failure)
	}
	if userAgent != "Atlas Plugin/1" {
		t.Fatalf("user-agent=%q", userAgent)
	}
}

func TestWireRejectsUnknownFieldsMalformedTuplesAndPaths(t *testing.T) {
	for _, input := range []string{
		`{"method":"GET","path":"/","query":[],"headers":[],"body_base64":null,"extra":true}`,
		`{"method":"GET","path":"/","query":[["one"]],"headers":[],"body_base64":null}`,
		`{"method":"GET","path":"/","query":[],"headers":[],"body_base64":""}`,
	} {
		if _, err := decodeRequest(strings.NewReader(input)); err == nil {
			t.Fatalf("expected strict decode failure for %s", input)
		}
	}
	for _, path := range []string{"http://evil.test/x", "//evil.test/x", "/a/../b", "/a\\b", "/a?b"} {
		if err := validateDecodedPath(path); err == nil {
			t.Fatalf("expected path %q to fail", path)
		}
	}
	config := testConnectorConfig()
	gateway, err := New(Config{Connectors: []ConnectorConfig{config}}, Options{Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("must not be called")
	})}})
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, failure := gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
		Method: "get", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{},
	})
	if failure == nil || failure.code != FailureRequestRejected {
		t.Fatalf("lowercase method = %v", failure)
	}
	nonCanonicalBase64 := "Zh=="
	_, _, _, failure = gateway.execute(context.Background(), gateway.connectors["reference"], ConnectorRequest{
		Method: "GET", Path: "/fixture", Query: []HeaderTuple{}, Headers: []HeaderTuple{}, BodyBase64: &nonCanonicalBase64,
	})
	if failure == nil || failure.code != FailureRequestRejected {
		t.Fatalf("non-canonical base64 = %v", failure)
	}
	data, err := json.Marshal(HeaderTuple{"a", "b"})
	if err != nil || string(data) != `["a","b"]` {
		t.Fatalf("tuple encoding changed: %s %v", data, err)
	}
}
