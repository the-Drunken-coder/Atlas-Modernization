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
	"strconv"
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

	rateMu        sync.Mutex
	nextRequest   time.Time
	rateChanged   chan struct{}
	stateMu       sync.Mutex
	completionMu  sync.Mutex
	openUntil     time.Time
	breakerSerial uint64
	completionSeq uint64
	// Unresolved attempts block compaction. Completed failures remain ordered until the latest
	// reachable response or a fully settled open interval makes older history irrelevant.
	breakerAttempts map[uint64]struct{}
	breakerFailures []breakerFailure
	breakerCredits  []breakerCredit
	lastReachable   breakerOrder
}

type breakerOrder struct {
	completedAt time.Time
	serial      uint64
}

type breakerAttempt struct {
	id uint64
}

type breakerFailure struct {
	order      breakerOrder
	observedAt time.Time
}

type breakerCredit struct {
	groups    int
	through   breakerOrder
	expiredAt time.Time
}

// breakerHistoryLimit fails closed if an uncooperative transport prevents safe compaction.
// Each unresolved attempt reserves one additional record for a possible expired-interval credit.
const breakerHistoryLimit = 4_096

type gatewayError struct {
	code FailureCode
	err  error
}

const failureRequestCanceled FailureCode = "request_canceled"

var errConnectorDeadline = errors.New("source gateway connector deadline")

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
				DisableCompression:    true,
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
			semaphore:       make(chan struct{}, connectorConfig.Limits.MaxConcurrency),
			rateChanged:     make(chan struct{}),
			breakerAttempts: make(map[uint64]struct{}),
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
	if wellKnownIPv4TranslationPrefix.Contains(address) {
		bits := address.As16()
		return addressAllowed(netip.AddrFrom4([4]byte{bits[12], bits[13], bits[14], bits[15]}), policy)
	}
	// The local-use /48 permits multiple embedding prefix lengths. Without the
	// connector's translation prefix, the embedded IPv4 destination is ambiguous.
	if localIPv4TranslationPrefix.Contains(address) {
		return false
	}
	if address.IsLoopback() {
		return policy.AllowLoopback
	}
	if address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() {
		return policy.AllowLinkLocal
	}
	if address.IsPrivate() || isSpecialNonPublic(address) {
		return policy.AllowPrivate
	}
	return true
}

var (
	wellKnownIPv4TranslationPrefix = netip.MustParsePrefix("64:ff9b::/96")
	localIPv4TranslationPrefix     = netip.MustParsePrefix("64:ff9b:1::/48")
)

var specialNonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fec0::/10"),
}

func isSpecialNonPublic(address netip.Addr) bool {
	for _, prefix := range specialNonPublicPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
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
		if gatewayErr.code == failureRequestCanceled {
			return
		}
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
	if contextExpired(ctx, time.Now()) {
		return ConnectorResponse{}, 0, "bypass", requestCanceled(ctx)
	}
	prepared, rule, err := connector.prepare(input)
	if err != nil {
		return ConnectorResponse{}, 0, "bypass", err
	}
	key := requestCacheKey(connector.config.ID, prepared)
	if rule.Cache.TTLMS > 0 {
		if cached, ok := g.cache.get(key, g.now()); ok {
			if contextExpired(ctx, time.Now()) {
				return ConnectorResponse{}, 0, "hit", requestCanceled(ctx)
			}
			return cached, 0, "hit", nil
		}
	}
	if connector.circuitOpenWithClock(g.now) {
		if contextExpired(ctx, time.Now()) {
			return ConnectorResponse{}, 0, "miss", requestCanceled(ctx)
		}
		return ConnectorResponse{}, 0, "miss", &gatewayError{code: FailureCircuitOpen}
	}
	connectorDeadline := time.Now().Add(time.Duration(connector.config.Limits.TimeoutMS) * time.Millisecond)
	requestContext, cancel := context.WithDeadlineCause(
		ctx,
		connectorDeadline,
		errConnectorDeadline,
	)
	defer cancel()
	if contextExpired(requestContext, time.Now()) {
		return ConnectorResponse{}, 0, "miss", admissionFailure(ctx, requestContext)
	}
	select {
	case connector.semaphore <- struct{}{}:
		defer func() { <-connector.semaphore }()
	case <-requestContext.Done():
		return ConnectorResponse{}, 0, "miss", admissionFailure(ctx, requestContext)
	}
	if contextExpired(requestContext, time.Now()) {
		return ConnectorResponse{}, 0, "miss", admissionFailure(ctx, requestContext)
	}
	if connector.circuitOpenWithClock(g.now) {
		if contextExpired(requestContext, time.Now()) {
			return ConnectorResponse{}, 0, "miss", admissionFailure(ctx, requestContext)
		}
		return ConnectorResponse{}, 0, "miss", &gatewayError{code: FailureCircuitOpen}
	}
	maxAttempts := rule.Retry.MaxRetries + 1
	var pendingRetryAttempt breakerAttempt
	var pendingRetryOrder breakerOrder
	retryFailurePending := false
	recordPendingFailure := func() {
		if retryFailurePending {
			connector.finishBreakerFailure(g.now(), pendingRetryAttempt, pendingRetryOrder)
			retryFailurePending = false
		}
	}
	discardPendingFailure := func() {
		if retryFailurePending {
			connector.discardBreakerAttempt(pendingRetryAttempt)
			retryFailurePending = false
		}
	}
	finishBeforeAttempt := func(reservation rateReservation) {
		recordPendingFailure()
		connector.releaseRate(reservation)
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		reservation, err := connector.waitForRate(requestContext, g.now)
		if err != nil {
			recordPendingFailure()
			return ConnectorResponse{}, attempt - 1, "miss", admissionFailure(ctx, requestContext)
		}
		if contextExpired(requestContext, time.Now()) {
			finishBeforeAttempt(reservation)
			return ConnectorResponse{}, attempt - 1, "miss", admissionFailure(ctx, requestContext)
		}
		breakerAttempt, startFailure := connector.tryBeginAttempt(ctx, requestContext, g.now)
		if startFailure != nil {
			finishBeforeAttempt(reservation)
			return ConnectorResponse{}, attempt - 1, "miss", startFailure
		}
		response, failure, attemptOrder := connector.attempt(requestContext, prepared, rule)
		attemptCheckedAt := time.Now()
		parentContextError := contextError(ctx, attemptCheckedAt)
		connectorTimedOut := connectorDeadlineWon(
			ctx,
			requestContext,
			connectorDeadline,
			attemptOrder.completedAt,
		)
		if parentContextError != nil || connectorTimedOut {
			attemptFailure := failure
			if parentContextError != nil {
				failure = &gatewayError{code: failureRequestCanceled, err: parentContextError}
			} else {
				failure = &gatewayError{code: FailureUpstreamTimeout, err: contextError(requestContext, attemptCheckedAt)}
			}
			parentCause := context.Cause(ctx)
			switch {
			case connectorTimedOut:
				discardPendingFailure()
				deadlineOrder := attemptOrder
				deadlineOrder.completedAt = connectorDeadline
				connector.finishBreakerFailure(g.now(), breakerAttempt, deadlineOrder)
			case attemptFailure == nil:
				discardPendingFailure()
				connector.finishBreakerReachable(g.now(), breakerAttempt, attemptOrder)
			case errors.Is(attemptFailure.err, parentContextError) ||
				(parentCause != nil && errors.Is(attemptFailure.err, parentCause)):
				recordPendingFailure()
				connector.discardBreakerAttempt(breakerAttempt)
			default:
				discardPendingFailure()
				connector.finishBreakerFailure(g.now(), breakerAttempt, attemptOrder)
			}
			return ConnectorResponse{}, attempt, "miss", failure
		}
		if failure == nil {
			discardPendingFailure()
			connector.finishBreakerReachable(g.now(), breakerAttempt, attemptOrder)
			retryable := retryStatus(rule.Retry.Statuses, response.Status)
			if attempt < maxAttempts && retryable {
				continue
			}
			cacheResult := "bypass"
			if rule.Cache.TTLMS > 0 && !retryable && cacheableStatus(response.Status) {
				g.cache.put(key, response, g.now().Add(time.Duration(rule.Cache.TTLMS)*time.Millisecond))
				cacheResult = "stored"
			} else if rule.Cache.TTLMS > 0 {
				cacheResult = "miss"
			}
			return response, attempt, cacheResult, nil
		}
		if attempt < maxAttempts && retryFailure(rule.Retry.Failures, failure.code) {
			discardPendingFailure()
			pendingRetryAttempt = breakerAttempt
			pendingRetryOrder = attemptOrder
			retryFailurePending = true
			continue
		}
		discardPendingFailure()
		connector.finishBreakerFailure(g.now(), breakerAttempt, attemptOrder)
		return ConnectorResponse{}, attempt, "miss", failure
	}
	panic("unreachable")
}

func cacheableStatus(status int) bool {
	return status < http.StatusInternalServerError && status != http.StatusTooManyRequests
}

type preparedRequest struct {
	method  string
	path    string
	query   []HeaderTuple
	headers []HeaderTuple
	body    []byte
}

func (c *connector) prepare(input ConnectorRequest) (preparedRequest, RouteRule, *gatewayError) {
	if input.Method != strings.TrimSpace(input.Method) || input.Method != strings.ToUpper(input.Method) {
		return preparedRequest{}, RouteRule{}, rejected(errors.New("method must use its canonical uppercase form"))
	}
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
		if err != nil || base64.StdEncoding.EncodeToString(decoded) != *input.BodyBase64 {
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

func (c *connector) attempt(
	ctx context.Context,
	prepared preparedRequest,
	rule RouteRule,
) (
	ConnectorResponse,
	*gatewayError,
	breakerOrder,
) {
	target := *c.origin
	target.Path = prepared.path
	target.RawPath = ""
	target.RawQuery = encodeQuery(prepared.query)
	request, err := http.NewRequestWithContext(ctx, prepared.method, target.String(), bytes.NewReader(prepared.body))
	if err != nil {
		return ConnectorResponse{}, rejected(err), c.recordBreakerCompletion()
	}
	for _, tuple := range prepared.headers {
		request.Header.Add(tuple[0], tuple[1])
	}
	for name, value := range c.secretHeaders {
		request.Header.Set(name, value)
	}
	if !containsHeader(prepared.headers, "user-agent") {
		request.Header.Set("User-Agent", "")
	}
	request.ContentLength = int64(len(prepared.body))
	response, err := c.client.Do(request)
	if err != nil {
		completedAt := time.Now()
		order := c.recordBreakerCompletionAt(completedAt)
		if errors.Is(err, context.DeadlineExceeded) {
			return ConnectorResponse{}, &gatewayError{code: FailureUpstreamTimeout, err: err}, order
		}
		return ConnectorResponse{}, &gatewayError{code: FailureUpstreamUnreachable, err: err}, order
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, c.config.Limits.MaxResponseBytes+1))
	completedAt := time.Now()
	order := c.recordBreakerCompletionAt(completedAt)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ConnectorResponse{}, &gatewayError{code: FailureUpstreamTimeout, err: err}, order
		}
		return ConnectorResponse{}, &gatewayError{code: FailureUpstreamUnreachable, err: err}, order
	}
	if int64(len(body)) > c.config.Limits.MaxResponseBytes {
		return ConnectorResponse{}, &gatewayError{code: FailureResponseTooLarge}, order
	}
	headers, err := c.responseHeaders(response.Header, rule.AllowedResponseHeaders, c.config.Limits)
	if err != nil {
		return ConnectorResponse{}, &gatewayError{code: FailureResponseTooLarge, err: err}, order
	}
	return ConnectorResponse{Status: response.StatusCode, Headers: headers, BodyBase64: base64.StdEncoding.EncodeToString(body)}, nil, order
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

type rateReservation struct {
	grantedAt time.Time
	next      time.Time
}

func (c *connector) waitForRate(ctx context.Context, now func() time.Time) (rateReservation, error) {
	if c.config.Rate.RequestsPerSecond == 0 {
		return rateReservation{}, nil
	}
	interval := time.Duration(float64(time.Second) / c.config.Rate.RequestsPerSecond)
	for {
		c.rateMu.Lock()
		if err := ctx.Err(); err != nil {
			c.rateMu.Unlock()
			return rateReservation{}, err
		}
		current := now()
		if err := ctx.Err(); err != nil {
			c.rateMu.Unlock()
			return rateReservation{}, err
		}
		waitUntil := c.nextRequest
		if waitUntil.Before(current) {
			waitUntil = current
		}
		if !waitUntil.After(current) {
			next := waitUntil.Add(interval)
			c.nextRequest = next
			c.rateMu.Unlock()
			return rateReservation{grantedAt: waitUntil, next: next}, nil
		}
		rateChanged := c.rateChanged
		c.rateMu.Unlock()

		timer := time.NewTimer(waitUntil.Sub(current))
		select {
		case <-timer.C:
			c.rateMu.Lock()
			if c.nextRequest.Equal(waitUntil) {
				if err := ctx.Err(); err != nil {
					c.rateMu.Unlock()
					return rateReservation{}, err
				}
				next := waitUntil.Add(interval)
				c.nextRequest = next
				c.rateMu.Unlock()
				return rateReservation{grantedAt: waitUntil, next: next}, nil
			}
			c.rateMu.Unlock()
		case <-rateChanged:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return rateReservation{}, ctx.Err()
		}
	}
}

func (c *connector) releaseRate(reservation rateReservation) {
	if reservation.next.IsZero() {
		return
	}
	c.rateMu.Lock()
	defer c.rateMu.Unlock()
	if c.nextRequest.Equal(reservation.next) {
		c.nextRequest = reservation.grantedAt
		close(c.rateChanged)
		c.rateChanged = make(chan struct{})
	}
}

func (order breakerOrder) after(other breakerOrder) bool {
	return order.completedAt.After(other.completedAt) ||
		(order.completedAt.Equal(other.completedAt) && order.serial > other.serial)
}

func (c *connector) recordBreakerCompletion() breakerOrder {
	return c.recordBreakerCompletionAt(time.Now())
}

func (c *connector) recordBreakerCompletionWithClock(now func() time.Time) breakerOrder {
	return c.recordBreakerCompletionAt(now())
}

func (c *connector) recordBreakerCompletionAt(completedAt time.Time) breakerOrder {
	c.completionMu.Lock()
	defer c.completionMu.Unlock()
	c.completionSeq++
	return breakerOrder{completedAt: completedAt, serial: c.completionSeq}
}

func (c *connector) circuitOpenWithClock(now func() time.Time) bool {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	checkedAt := now()
	c.expireBreakerLocked(checkedAt)
	return checkedAt.Before(c.openUntil)
}

func (c *connector) tryBeginAttempt(
	parent context.Context,
	requestContext context.Context,
	now func() time.Time,
) (breakerAttempt, *gatewayError) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	startedAt := time.Now()
	if contextExpired(requestContext, startedAt) {
		return breakerAttempt{}, admissionFailureAt(parent, requestContext, startedAt)
	}
	breakerNow := now()
	c.expireBreakerLocked(breakerNow)
	admittedAt := time.Now()
	if contextExpired(requestContext, admittedAt) {
		return breakerAttempt{}, admissionFailureAt(parent, requestContext, admittedAt)
	}
	if breakerNow.Before(c.openUntil) || c.breakerHistoryCostLocked()+2 > breakerHistoryLimit {
		return breakerAttempt{}, &gatewayError{code: FailureCircuitOpen}
	}
	c.breakerSerial++
	attempt := breakerAttempt{id: c.breakerSerial}
	c.breakerAttempts[attempt.id] = struct{}{}
	return attempt, nil
}

func (c *connector) finishBreakerFailure(observedAt time.Time, attempt breakerAttempt, order breakerOrder) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if !c.takeBreakerAttemptLocked(attempt) {
		return
	}
	if order.after(c.lastReachable) {
		c.breakerFailures = append(c.breakerFailures, breakerFailure{order: order, observedAt: observedAt})
	}
	c.settleExpiredBreakerGroupsLocked()
	c.recomputeBreakerLocked()
	c.expireBreakerLocked(observedAt)
}

func (c *connector) finishBreakerReachable(observedAt time.Time, attempt breakerAttempt, order breakerOrder) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if !c.takeBreakerAttemptLocked(attempt) {
		return
	}
	if order.after(c.lastReachable) {
		c.lastReachable = order
		remaining := c.breakerFailures[:0]
		for _, failure := range c.breakerFailures {
			if failure.order.after(order) {
				remaining = append(remaining, failure)
			}
		}
		c.breakerFailures = remaining
	}
	c.settleExpiredBreakerGroupsLocked()
	c.recomputeBreakerLocked()
	c.expireBreakerLocked(observedAt)
}

func (c *connector) discardBreakerAttempt(attempt breakerAttempt) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.takeBreakerAttemptLocked(attempt) {
		c.settleExpiredBreakerGroupsLocked()
		c.recomputeBreakerLocked()
	}
}

func (c *connector) takeBreakerAttemptLocked(attempt breakerAttempt) bool {
	if _, ok := c.breakerAttempts[attempt.id]; !ok {
		return false
	}
	delete(c.breakerAttempts, attempt.id)
	return true
}

func (c *connector) expireBreakerLocked(now time.Time) {
	if c.openUntil.IsZero() || now.Before(c.openUntil) {
		return
	}
	c.openUntil = time.Time{}
	c.sortBreakerFailuresLocked()
	threshold := c.config.CircuitBreaker.Failures
	credited := c.creditedFailureCountLocked()
	groups := (len(c.breakerFailures) - credited) / threshold
	if groups > 0 {
		lastCredited := credited + groups*threshold - 1
		c.breakerCredits = append(c.breakerCredits, breakerCredit{
			groups:    groups,
			through:   c.breakerFailures[lastCredited].order,
			expiredAt: now,
		})
	}
	if len(c.breakerAttempts) != 0 {
		return
	}
	c.settleExpiredBreakerGroupsLocked()
	c.recomputeBreakerLocked()
}

func (c *connector) settleExpiredBreakerGroupsLocked() {
	if len(c.breakerAttempts) != 0 || len(c.breakerCredits) == 0 {
		return
	}
	c.sortBreakerFailuresLocked()
	c.breakerFailures = c.breakerFailures[c.creditedFailureCountLocked():]
	c.breakerCredits = nil
}

func (c *connector) sortBreakerFailuresLocked() {
	sort.SliceStable(c.breakerFailures, func(left, right int) bool {
		return c.breakerFailures[right].order.after(c.breakerFailures[left].order)
	})
}

func (c *connector) creditedFailureCountLocked() int {
	threshold := c.config.CircuitBreaker.Failures
	openDuration := time.Duration(c.config.CircuitBreaker.OpenMS) * time.Millisecond
	credited := 0
	for _, credit := range c.breakerCredits {
		for group := 0; group < credit.groups && credited+threshold <= len(c.breakerFailures); group++ {
			observedAt := c.breakerFailures[credited].observedAt
			eligible := true
			for _, failure := range c.breakerFailures[credited : credited+threshold] {
				if failure.order.after(credit.through) {
					eligible = false
					break
				}
				if failure.observedAt.After(observedAt) {
					observedAt = failure.observedAt
				}
			}
			if !eligible || observedAt.Add(openDuration).After(credit.expiredAt) {
				break
			}
			credited += threshold
		}
	}
	return credited
}

func (c *connector) breakerHistoryCostLocked() int {
	return len(c.breakerFailures) + len(c.breakerCredits) + 2*len(c.breakerAttempts)
}

func (c *connector) recomputeBreakerLocked() {
	c.sortBreakerFailuresLocked()
	threshold := c.config.CircuitBreaker.Failures
	openDuration := time.Duration(c.config.CircuitBreaker.OpenMS) * time.Millisecond
	c.openUntil = time.Time{}
	for start := c.creditedFailureCountLocked(); start+threshold <= len(c.breakerFailures); start += threshold {
		observedAt := c.breakerFailures[start].observedAt
		for _, failure := range c.breakerFailures[start+1 : start+threshold] {
			if failure.observedAt.After(observedAt) {
				observedAt = failure.observedAt
			}
		}
		if candidate := observedAt.Add(openDuration); candidate.After(c.openUntil) {
			c.openUntil = candidate
		}
	}
}

func rejected(err error) *gatewayError { return &gatewayError{code: FailureRequestRejected, err: err} }

func contextExpired(ctx context.Context, now time.Time) bool {
	return contextError(ctx, now) != nil
}

func contextError(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !now.Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

func connectorDeadlineWon(
	parent context.Context,
	requestContext context.Context,
	connectorDeadline time.Time,
	completedAt time.Time,
) bool {
	if completedAt.Before(connectorDeadline) {
		return false
	}
	parentDeadline, hasParentDeadline := parent.Deadline()
	if hasParentDeadline && !parentDeadline.After(connectorDeadline) {
		return false
	}
	if errors.Is(context.Cause(requestContext), errConnectorDeadline) {
		return true
	}
	parentErr := parent.Err()
	if parentErr == nil || errors.Is(parentErr, context.DeadlineExceeded) {
		return true
	}
	return errors.Is(context.Cause(requestContext), errConnectorDeadline)
}

func admissionFailure(parent, requestContext context.Context) *gatewayError {
	return admissionFailureAt(parent, requestContext, time.Now())
}

func admissionFailureAt(parent, requestContext context.Context, now time.Time) *gatewayError {
	if err := contextError(parent, now); err != nil {
		return &gatewayError{code: failureRequestCanceled, err: err}
	}
	err := contextError(requestContext, now)
	return &gatewayError{code: FailureAdmissionTimeout, err: err}
}

func requestCanceled(ctx context.Context) *gatewayError {
	return &gatewayError{code: failureRequestCanceled, err: contextError(ctx, time.Now())}
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

func requestCacheKey(connectorID string, request preparedRequest) string {
	hash := sha256.New()
	writeCachePart(hash, []byte("connector"))
	writeCachePart(hash, []byte(connectorID))
	writeCachePart(hash, []byte("method"))
	writeCachePart(hash, []byte(request.method))
	writeCachePart(hash, []byte("path"))
	writeCachePart(hash, []byte(request.path))
	writeCachePart(hash, []byte("query"))
	writeCachePart(hash, []byte(strconv.Itoa(len(request.query))))
	for _, tuple := range request.query {
		writeCachePart(hash, []byte(tuple[0]))
		writeCachePart(hash, []byte(tuple[1]))
	}
	writeCachePart(hash, []byte("headers"))
	writeCachePart(hash, []byte(strconv.Itoa(len(request.headers))))
	for _, tuple := range request.headers {
		writeCachePart(hash, []byte(tuple[0]))
		writeCachePart(hash, []byte(tuple[1]))
	}
	writeCachePart(hash, []byte("body"))
	writeCachePart(hash, request.body)
	return hex.EncodeToString(hash.Sum(nil))
}

func writeCachePart(target io.Writer, value []byte) {
	_, _ = io.WriteString(target, strconv.Itoa(len(value)))
	_, _ = io.WriteString(target, ":")
	_, _ = target.Write(value)
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
		FailureCircuitOpen: http.StatusServiceUnavailable, FailureAdmissionTimeout: http.StatusServiceUnavailable,
		FailureUpstreamTimeout: http.StatusGatewayTimeout,
	}[failure.code]
	writeJSON(writer, status, FailureResponse{Code: failure.code})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
