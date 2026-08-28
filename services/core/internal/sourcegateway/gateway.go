package sourcegateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"
)

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type Options struct {
	Client   *http.Client
	Resolver Resolver
	Logger   zerolog.Logger
	Now      func() time.Time
}

type Gateway struct {
	connectors map[string]*connector
	cache      *responseCache
	logger     zerolog.Logger
	now        func() time.Time
}

type connector struct {
	config        ConnectorConfig
	origin        *url.URL
	client        *http.Client
	secretHeaders map[string]string
	semaphore     chan struct{}

	rateMu      sync.Mutex
	nextRequest time.Time
	stateMu     sync.Mutex
	failures    int
	openUntil   time.Time
}

type gatewayError struct {
	code FailureCode
	err  error
}

func (e *gatewayError) Error() string { return string(e.code) }
func (e *gatewayError) Unwrap() error { return e.err }

func New(cfg Config, options Options) (*Gateway, error) {
	if err := cfg.normalize(); err != nil {
		return nil, err
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	resolver := options.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	gateway := &Gateway{
		connectors: make(map[string]*connector, len(cfg.Connectors)),
		cache:      newResponseCache(cfg.CacheMaxEntries, cfg.CacheMaxBytes),
		logger:     options.Logger,
		now:        now,
	}
	for index := range cfg.Connectors {
		connectorConfig := &cfg.Connectors[index]
		origin, _ := url.Parse(connectorConfig.Origin)
		secrets, err := resolveSecretHeaders(connectorConfig.SecretHeaders)
		if err != nil {
			return nil, fmt.Errorf("connector %q: %w", connectorConfig.ID, err)
		}
		client := options.Client
		if client == nil {
			transport := &http.Transport{
				Proxy:                 nil,
				ForceAttemptHTTP2:     false,
				MaxConnsPerHost:       connectorConfig.Limits.MaxConcurrency,
				MaxIdleConnsPerHost:   connectorConfig.Limits.MaxConcurrency,
				ResponseHeaderTimeout: time.Duration(connectorConfig.Limits.TimeoutMS) * time.Millisecond,
			}
			transport.DialContext = dialContext(resolver, connectorConfig.Egress)
			client = &http.Client{Transport: transport}
		} else {
			copy := *client
			client = &copy
		}
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		gateway.connectors[connectorConfig.ID] = &connector{
			config: *connectorConfig, origin: origin, client: client, secretHeaders: secrets,
			semaphore: make(chan struct{}, connectorConfig.Limits.MaxConcurrency),
		}
	}
	return gateway, nil
}

func resolveSecretHeaders(references map[string]SecretRef) (map[string]string, error) {
	resolved := make(map[string]string, len(references))
	for header, reference := range references {
		var value string
		if reference.Environment != "" {
			value = strings.TrimSpace(os.Getenv(reference.Environment))
			if value == "" {
				return nil, fmt.Errorf("environment variable %s is empty", reference.Environment)
			}
		} else {
			// #nosec G304 -- the deployment operator supplies the secret path.
			contents, err := os.ReadFile(reference.File)
			if err != nil {
				return nil, fmt.Errorf("read secret for %s: %w", header, err)
			}
			value = strings.TrimSpace(string(contents))
			if value == "" {
				return nil, fmt.Errorf("secret file for %s is empty", header)
			}
		}
		value = reference.Prefix + value
		if !validHeaderValue(value) {
			return nil, fmt.Errorf("secret for %s is not a valid HTTP header value", header)
		}
		resolved[header] = value
	}
	return resolved, nil
}

func dialContext(resolver Resolver, policy EgressPolicy) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses, err := resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		for _, candidate := range addresses {
			parsed := candidate.Unmap()
			if !addressAllowed(parsed, policy) {
				continue
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(parsed.String(), port))
		}
		return nil, errors.New("origin resolved only to forbidden addresses")
	}
}

func addressAllowed(address netip.Addr, policy EgressPolicy) bool {
	if !address.IsValid() || address.IsUnspecified() || address.IsMulticast() {
		return false
	}
	if address.IsLoopback() {
		return policy.AllowLoopback
	}
	if address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() {
		return policy.AllowLinkLocal
	}
	if address.IsPrivate() {
		return policy.AllowPrivate
	}
	return true
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /connectors/{connector_id}/requests", g.handleRequest)
	return mux
}

func (g *Gateway) handleRequest(writer http.ResponseWriter, request *http.Request) {
	started := g.now()
	connectorID := request.PathValue("connector_id")
	if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); mediaType != "application/json" {
		g.logRequest(connectorID, string(FailureRequestRejected), 0, started, 1, "bypass")
		writeFailure(writer, &gatewayError{code: FailureRequestRejected})
		return
	}
	connector := g.connectors[connectorID]
	if connector == nil {
		g.logRequest(connectorID, string(FailureUnknownConnector), 0, started, 1, "bypass")
		writeFailure(writer, &gatewayError{code: FailureUnknownConnector})
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, HardMaxWireRequestBytes)
	input, err := decodeRequest(request.Body)
	if err != nil {
		g.logRequest(connectorID, string(FailureRequestRejected), 0, started, 1, "bypass")
		writeFailure(writer, &gatewayError{code: FailureRequestRejected, err: err})
		return
	}
	response, attempts, cacheResult, gatewayErr := g.execute(request.Context(), connector, input)
	if gatewayErr != nil {
		g.logRequest(connectorID, string(gatewayErr.code), 0, started, attempts, cacheResult)
		writeFailure(writer, gatewayErr)
		return
	}
	encoded, err := encodeJSON(response, HardMaxWireResponseBytes)
	if err != nil {
		g.logRequest(connectorID, string(FailureResponseTooLarge), response.Status, started, attempts, cacheResult)
		writeFailure(writer, &gatewayError{code: FailureResponseTooLarge, err: err})
		return
	}
	g.logRequest(connectorID, "response", response.Status, started, attempts, cacheResult)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(encoded)
}

func (g *Gateway) logRequest(connectorID, outcome string, upstreamStatus int, started time.Time, attempts int, cacheResult string) {
	retries := attempts - 1
	if retries < 0 {
		retries = 0
	}
	g.logger.Info().
		Str("connector_id", connectorID).
		Str("outcome", outcome).
		Int("upstream_status", upstreamStatus).
		Int64("duration_ms", g.now().Sub(started).Milliseconds()).
		Int("retries", retries).
		Str("cache_result", cacheResult).
		Msg("Source Gateway request")
}

func (g *Gateway) execute(ctx context.Context, connector *connector, input ConnectorRequest) (ConnectorResponse, int, string, *gatewayError) {
	prepared, rule, err := connector.prepare(input)
	if err != nil {
		return ConnectorResponse{}, 1, "bypass", err
	}
	key := requestCacheKey(connector.config.ID, prepared)
	if rule.Cache.TTLMS > 0 {
		if cached, ok := g.cache.get(key, g.now()); ok {
			return cached, 1, "hit", nil
		}
	}
	if connector.circuitOpen(g.now()) {
		return ConnectorResponse{}, 1, "miss", &gatewayError{code: FailureCircuitOpen}
	}
	requestContext, cancel := context.WithTimeout(ctx, time.Duration(connector.config.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	select {
	case connector.semaphore <- struct{}{}:
		defer func() { <-connector.semaphore }()
	case <-requestContext.Done():
		return ConnectorResponse{}, 1, "miss", timeoutOrCancellation(requestContext)
	}
	if err := connector.waitForRate(requestContext, g.now); err != nil {
		return ConnectorResponse{}, 1, "miss", timeoutOrCancellation(requestContext)
	}
	maxAttempts := rule.Retry.MaxRetries + 1
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		response, failure := connector.attempt(requestContext, prepared, rule)
		if failure == nil {
			connector.recordReachable()
			if attempt < maxAttempts && retryStatus(rule.Retry.Statuses, response.Status) {
				continue
			}
			if rule.Cache.TTLMS > 0 {
				g.cache.put(key, response, g.now().Add(time.Duration(rule.Cache.TTLMS)*time.Millisecond))
			}
			return response, attempt, cacheOutcome(rule.Cache.TTLMS), nil
		}
		if errors.Is(requestContext.Err(), context.Canceled) && errors.Is(ctx.Err(), context.Canceled) {
			return ConnectorResponse{}, attempt, "miss", failure
		}
		if attempt < maxAttempts && retryFailure(rule.Retry.Failures, failure.code) {
			continue
		}
		connector.recordFailure(g.now())
		return ConnectorResponse{}, attempt, "miss", failure
	}
	panic("unreachable")
}

type preparedRequest struct {
	method  string
	path    string
	query   []HeaderTuple
	headers []HeaderTuple
	body    []byte
}

func (c *connector) prepare(input ConnectorRequest) (preparedRequest, RouteRule, *gatewayError) {
	input.Method = strings.ToUpper(strings.TrimSpace(input.Method))
	if err := validateDecodedPath(input.Path); err != nil {
		return preparedRequest{}, RouteRule{}, rejected(err)
	}
	rule, ok := c.route(input.Method, input.Path)
	if !ok {
		return preparedRequest{}, RouteRule{}, rejected(errors.New("request does not match an allowed route"))
	}
	allowedQuery := stringSet(rule.AllowedQueryNames)
	for _, tuple := range input.Query {
		if !utf8.ValidString(tuple[0]) || !utf8.ValidString(tuple[1]) || !allowedQuery[tuple[0]] {
			return preparedRequest{}, RouteRule{}, rejected(errors.New("query is not allowed"))
		}
	}
	if err := requireHeaderBudget(input.Headers, c.config.Limits.MaxHeaderCount, c.config.Limits.MaxHeaderBytes); err != nil {
		return preparedRequest{}, RouteRule{}, rejected(err)
	}
	allowedHeaders := stringSet(rule.AllowedRequestHeaders)
	for index := range input.Headers {
		name := strings.ToLower(input.Headers[index][0])
		if !validHeaderName(name) || fixedForbiddenRequestHeaders[name] || !allowedHeaders[name] {
			return preparedRequest{}, RouteRule{}, rejected(fmt.Errorf("request header %s is not allowed", name))
		}
		if _, credential := c.secretHeaders[name]; credential {
			return preparedRequest{}, RouteRule{}, rejected(fmt.Errorf("credential header %s cannot be supplied", name))
		}
		input.Headers[index][0] = name
	}
	var body []byte
	if input.BodyBase64 != nil {
		decoded, err := base64.StdEncoding.Strict().DecodeString(*input.BodyBase64)
		if err != nil {
			return preparedRequest{}, RouteRule{}, rejected(errors.New("body_base64 is invalid"))
		}
		body = decoded
	}
	if int64(len(body)) > c.config.Limits.MaxRequestBytes {
		return preparedRequest{}, RouteRule{}, rejected(errors.New("request body exceeds connector limit"))
	}
	if rule.Retry.MaxRetries > 0 && !rule.ReadOnly && !containsHeader(input.Headers, rule.Retry.IdempotencyHeader) {
		return preparedRequest{}, RouteRule{}, rejected(errors.New("idempotency header is required"))
	}
	return preparedRequest{method: input.Method, path: input.Path, query: input.Query, headers: input.Headers, body: body}, rule, nil
}

func (c *connector) route(method, path string) (RouteRule, bool) {
	var selected RouteRule
	found := false
	for index := range c.config.Routes {
		rule := &c.config.Routes[index]
		if rule.Method == method && strings.HasPrefix(path, rule.PathPrefix) && (!found || len(rule.PathPrefix) > len(selected.PathPrefix)) {
			selected, found = *rule, true
		}
	}
	return selected, found
}

func (c *connector) attempt(ctx context.Context, prepared preparedRequest, rule RouteRule) (ConnectorResponse, *gatewayError) {
	target := *c.origin
	target.Path = prepared.path
	target.RawPath = ""
	target.RawQuery = encodeQuery(prepared.query)
	request, err := http.NewRequestWithContext(ctx, prepared.method, target.String(), bytes.NewReader(prepared.body))
	if err != nil {
		return ConnectorResponse{}, rejected(err)
	}
	for _, tuple := range prepared.headers {
		request.Header.Add(tuple[0], tuple[1])
	}
	for name, value := range c.secretHeaders {
		request.Header.Set(name, value)
	}
	request.ContentLength = int64(len(prepared.body))
	response, err := c.client.Do(request)
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			return ConnectorResponse{}, &gatewayError{code: FailureUpstreamTimeout, err: err}
		}
		return ConnectorResponse{}, &gatewayError{code: FailureUpstreamUnreachable, err: err}
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, c.config.Limits.MaxResponseBytes+1))
	if err != nil {
		return ConnectorResponse{}, &gatewayError{code: FailureUpstreamUnreachable, err: err}
	}
	if int64(len(body)) > c.config.Limits.MaxResponseBytes {
		return ConnectorResponse{}, &gatewayError{code: FailureResponseTooLarge}
	}
	headers, err := c.responseHeaders(response.Header, rule.AllowedResponseHeaders, c.config.Limits)
	if err != nil {
		return ConnectorResponse{}, &gatewayError{code: FailureResponseTooLarge, err: err}
	}
	return ConnectorResponse{Status: response.StatusCode, Headers: headers, BodyBase64: base64.StdEncoding.EncodeToString(body)}, nil
}

func (c *connector) responseHeaders(headers http.Header, allowedNames []string, limits ConnectorLimits) ([]HeaderTuple, error) {
	connectionNamed := cloneHeaderSet(fixedForbiddenResponseHeaders)
	for _, value := range headers.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			connectionNamed[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	for name := range c.secretHeaders {
		connectionNamed[name] = true
	}
	allowed := stringSet(allowedNames)
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, strings.ToLower(name))
	}
	sort.Strings(names)
	result := make([]HeaderTuple, 0)
	seen := make(map[string]bool)
	for _, name := range names {
		if seen[name] || connectionNamed[name] || !allowed[name] {
			continue
		}
		seen[name] = true
		for _, value := range headers.Values(name) {
			result = append(result, HeaderTuple{name, value})
		}
	}
	if err := requireHeaderBudget(result, limits.MaxHeaderCount, limits.MaxHeaderBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func encodeQuery(query []HeaderTuple) string {
	parts := make([]string, 0, len(query))
	for _, tuple := range query {
		name := strings.ReplaceAll(url.QueryEscape(tuple[0]), "+", "%20")
		value := strings.ReplaceAll(url.QueryEscape(tuple[1]), "+", "%20")
		parts = append(parts, name+"="+value)
	}
	return strings.Join(parts, "&")
}

func (c *connector) waitForRate(ctx context.Context, now func() time.Time) error {
	if c.config.Rate.RequestsPerSecond == 0 {
		return nil
	}
	interval := time.Duration(float64(time.Second) / c.config.Rate.RequestsPerSecond)
	c.rateMu.Lock()
	current := now()
	waitUntil := c.nextRequest
	if waitUntil.Before(current) {
		waitUntil = current
	}
	c.nextRequest = waitUntil.Add(interval)
	c.rateMu.Unlock()
	timer := time.NewTimer(time.Until(waitUntil))
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *connector) circuitOpen(now time.Time) bool {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return now.Before(c.openUntil)
}

func (c *connector) recordFailure(now time.Time) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	c.failures++
	if c.failures >= c.config.CircuitBreaker.Failures {
		c.openUntil = now.Add(time.Duration(c.config.CircuitBreaker.OpenMS) * time.Millisecond)
		c.failures = 0
	}
}

func (c *connector) recordReachable() {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	c.failures = 0
	c.openUntil = time.Time{}
}

func rejected(err error) *gatewayError { return &gatewayError{code: FailureRequestRejected, err: err} }

func timeoutOrCancellation(ctx context.Context) *gatewayError {
	return &gatewayError{code: FailureUpstreamTimeout, err: ctx.Err()}
}

func retryStatus(statuses []int, status int) bool {
	for _, configured := range statuses {
		if configured == status {
			return true
		}
	}
	return false
}

func retryFailure(failures []string, failure FailureCode) bool {
	for _, configured := range failures {
		if configured == string(failure) {
			return true
		}
	}
	return false
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func containsHeader(headers []HeaderTuple, name string) bool {
	for _, header := range headers {
		if strings.EqualFold(header[0], name) && header[1] != "" {
			return true
		}
	}
	return false
}

func cacheOutcome(ttl int64) string {
	if ttl > 0 {
		return "stored"
	}
	return "bypass"
}

func requestCacheKey(connectorID string, request preparedRequest) string {
	hash := sha256.New()
	_, _ = io.WriteString(hash, connectorID+"\x00"+request.method+"\x00"+request.path+"\x00")
	for _, tuple := range request.query {
		_, _ = io.WriteString(hash, tuple[0]+"\x00"+tuple[1]+"\x00")
	}
	for _, tuple := range request.headers {
		_, _ = io.WriteString(hash, tuple[0]+"\x00"+tuple[1]+"\x00")
	}
	_, _ = hash.Write(request.body)
	return hex.EncodeToString(hash.Sum(nil))
}

type cacheEntry struct {
	response ConnectorResponse
	expires  time.Time
	size     int64
	serial   uint64
}

type responseCache struct {
	mu         sync.Mutex
	entries    map[string]cacheEntry
	maxEntries int
	maxBytes   int64
	bytes      int64
	serial     uint64
}

func newResponseCache(maxEntries int, maxBytes int64) *responseCache {
	return &responseCache{entries: make(map[string]cacheEntry), maxEntries: maxEntries, maxBytes: maxBytes}
}

func (c *responseCache) get(key string, now time.Time) (ConnectorResponse, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || !now.Before(entry.expires) {
		if ok {
			delete(c.entries, key)
			c.bytes -= entry.size
		}
		return ConnectorResponse{}, false
	}
	return entry.response, true
}

func (c *responseCache) put(key string, response ConnectorResponse, expires time.Time) {
	size := int64(len(response.BodyBase64))
	for _, header := range response.Headers {
		size += int64(len(header[0]) + len(header[1]))
	}
	if size > c.maxBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if prior, ok := c.entries[key]; ok {
		c.bytes -= prior.size
	}
	c.serial++
	c.entries[key] = cacheEntry{response: response, expires: expires, size: size, serial: c.serial}
	c.bytes += size
	for len(c.entries) > c.maxEntries || c.bytes > c.maxBytes {
		var oldestKey string
		oldest := uint64(^uint64(0))
		for candidate, entry := range c.entries {
			if entry.serial < oldest {
				oldestKey, oldest = candidate, entry.serial
			}
		}
		entry := c.entries[oldestKey]
		delete(c.entries, oldestKey)
		c.bytes -= entry.size
	}
}

func writeFailure(writer http.ResponseWriter, failure *gatewayError) {
	status := map[FailureCode]int{
		FailureRequestRejected: http.StatusBadRequest, FailureUnknownConnector: http.StatusNotFound,
		FailureResponseTooLarge: http.StatusRequestEntityTooLarge, FailureUpstreamUnreachable: http.StatusBadGateway,
		FailureCircuitOpen: http.StatusServiceUnavailable, FailureUpstreamTimeout: http.StatusGatewayTimeout,
	}[failure.code]
	writeJSON(writer, status, FailureResponse{Code: failure.code})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
