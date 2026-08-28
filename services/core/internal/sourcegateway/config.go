// Package sourcegateway provides bounded private access to configured external sources.
package sourcegateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

const (
	HardMaxRequestBodyBytes  = 4 << 20
	HardMaxResponseBodyBytes = 16 << 20
	HardMaxWireRequestBytes  = 8 << 20
	HardMaxWireResponseBytes = 24 << 20
	HardMaxHeaderCount       = 128
	HardMaxHeaderBytes       = 256 << 10
	HardMaxTimeout           = 30 * time.Second
)

type Config struct {
	ListenAddress   string            `json:"listen_address"`
	CacheMaxEntries int               `json:"cache_max_entries"`
	CacheMaxBytes   int64             `json:"cache_max_bytes"`
	Connectors      []ConnectorConfig `json:"connectors"`
}

type ConnectorConfig struct {
	ID             string                 `json:"id"`
	Origin         string                 `json:"origin"`
	Routes         []RouteRule            `json:"routes"`
	SecretHeaders  map[string]SecretRef   `json:"secret_headers"`
	Egress         EgressPolicy           `json:"egress"`
	Limits         ConnectorLimits        `json:"limits"`
	Rate           RateLimit              `json:"rate"`
	CircuitBreaker CircuitBreakerSettings `json:"circuit_breaker"`
}

type RouteRule struct {
	Method                 string    `json:"method"`
	PathPrefix             string    `json:"path_prefix"`
	AllowedQueryNames      []string  `json:"allowed_query_names"`
	AllowedRequestHeaders  []string  `json:"allowed_request_headers"`
	AllowedResponseHeaders []string  `json:"allowed_response_headers"`
	ReadOnly               bool      `json:"read_only"`
	Cache                  CacheRule `json:"cache"`
	Retry                  RetryRule `json:"retry"`
}

type SecretRef struct {
	Environment string `json:"environment,omitempty"`
	File        string `json:"file,omitempty"`
	Prefix      string `json:"prefix,omitempty"`
}

type EgressPolicy struct {
	AllowPrivate   bool `json:"allow_private"`
	AllowLoopback  bool `json:"allow_loopback"`
	AllowLinkLocal bool `json:"allow_link_local"`
}

type ConnectorLimits struct {
	TimeoutMS        int64 `json:"timeout_ms"`
	MaxRequestBytes  int64 `json:"max_request_bytes"`
	MaxResponseBytes int64 `json:"max_response_bytes"`
	MaxConcurrency   int   `json:"max_concurrency"`
	MaxHeaderCount   int   `json:"max_header_count"`
	MaxHeaderBytes   int64 `json:"max_header_bytes"`
}

type RateLimit struct {
	RequestsPerSecond float64 `json:"requests_per_second"`
}

type CacheRule struct {
	TTLMS int64 `json:"ttl_ms"`
}

type RetryRule struct {
	MaxRetries        int      `json:"max_retries"`
	Statuses          []int    `json:"statuses"`
	Failures          []string `json:"failures"`
	IdempotencyHeader string   `json:"idempotency_header"`
}

type CircuitBreakerSettings struct {
	Failures int   `json:"failures"`
	OpenMS   int64 `json:"open_ms"`
}

func LoadConfig(path string) (Config, error) {
	// #nosec G304 -- the deployment operator supplies this private configuration path.
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open Source Gateway configuration: %w", err)
	}
	defer func() { _ = file.Close() }()
	decoder := json.NewDecoder(io.LimitReader(file, 4<<20))
	decoder.DisallowUnknownFields()
	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode Source Gateway configuration: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Config{}, fmt.Errorf("source gateway configuration contains trailing JSON")
	}
	if err := cfg.normalize(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c *Config) normalize() error {
	c.ListenAddress = strings.TrimSpace(c.ListenAddress)
	if c.ListenAddress == "" {
		c.ListenAddress = ":8080"
	}
	if c.CacheMaxEntries == 0 {
		c.CacheMaxEntries = 1024
	}
	if c.CacheMaxEntries < 1 || c.CacheMaxEntries > 100_000 {
		return fmt.Errorf("cache_max_entries must be between 1 and 100000")
	}
	if c.CacheMaxBytes == 0 {
		c.CacheMaxBytes = 32 << 20
	}
	if c.CacheMaxBytes < 1 || c.CacheMaxBytes > 256<<20 {
		return fmt.Errorf("cache_max_bytes must be between 1 and %d", 256<<20)
	}
	seen := make(map[string]struct{}, len(c.Connectors))
	for index := range c.Connectors {
		connector := &c.Connectors[index]
		if err := connector.normalize(); err != nil {
			return fmt.Errorf("connectors[%d]: %w", index, err)
		}
		if _, duplicate := seen[connector.ID]; duplicate {
			return fmt.Errorf("connector ID %q is configured more than once", connector.ID)
		}
		seen[connector.ID] = struct{}{}
	}
	return nil
}

func (c *ConnectorConfig) normalize() error {
	c.ID = strings.TrimSpace(c.ID)
	if !pluginid.Valid(c.ID) {
		return fmt.Errorf("id must match ^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
	}
	c.Origin = strings.TrimRight(strings.TrimSpace(c.Origin), "/")
	origin, err := url.Parse(c.Origin)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return fmt.Errorf("origin must be an HTTP origin without credentials, path, query, or fragment")
	}
	if len(c.Routes) == 0 {
		return fmt.Errorf("routes must contain at least one rule")
	}
	seenRoutes := make(map[string]struct{}, len(c.Routes))
	for index := range c.Routes {
		if err := c.Routes[index].normalize(); err != nil {
			return fmt.Errorf("routes[%d]: %w", index, err)
		}
		key := c.Routes[index].Method + " " + c.Routes[index].PathPrefix
		if _, duplicate := seenRoutes[key]; duplicate {
			return fmt.Errorf("route %s is configured more than once", key)
		}
		seenRoutes[key] = struct{}{}
	}
	normalizedSecrets := make(map[string]SecretRef, len(c.SecretHeaders))
	for name, reference := range c.SecretHeaders {
		name = strings.ToLower(strings.TrimSpace(name))
		if !validHeaderName(name) || fixedForbiddenRequestHeaders[name] {
			return fmt.Errorf("secret header %q is invalid", name)
		}
		reference.Environment = strings.TrimSpace(reference.Environment)
		reference.File = strings.TrimSpace(reference.File)
		if (reference.Environment == "") == (reference.File == "") {
			return fmt.Errorf("secret header %s must set exactly one of environment or file", name)
		}
		if _, duplicate := normalizedSecrets[name]; duplicate {
			return fmt.Errorf("secret header %s is configured more than once", name)
		}
		normalizedSecrets[name] = reference
	}
	c.SecretHeaders = normalizedSecrets

	if c.Limits.TimeoutMS == 0 {
		c.Limits.TimeoutMS = 10_000
	}
	if c.Limits.TimeoutMS < 1 || time.Duration(c.Limits.TimeoutMS)*time.Millisecond > HardMaxTimeout {
		return fmt.Errorf("limits.timeout_ms must be between 1 and %d", HardMaxTimeout/time.Millisecond)
	}
	if c.Limits.MaxRequestBytes == 0 {
		c.Limits.MaxRequestBytes = 256 << 10
	}
	if c.Limits.MaxRequestBytes < 1 || c.Limits.MaxRequestBytes > HardMaxRequestBodyBytes {
		return fmt.Errorf("limits.max_request_bytes must be between 1 and %d", HardMaxRequestBodyBytes)
	}
	if c.Limits.MaxResponseBytes == 0 {
		c.Limits.MaxResponseBytes = 4 << 20
	}
	if c.Limits.MaxResponseBytes < 1 || c.Limits.MaxResponseBytes > HardMaxResponseBodyBytes {
		return fmt.Errorf("limits.max_response_bytes must be between 1 and %d", HardMaxResponseBodyBytes)
	}
	if c.Limits.MaxConcurrency == 0 {
		c.Limits.MaxConcurrency = 4
	}
	if c.Limits.MaxConcurrency < 1 || c.Limits.MaxConcurrency > 64 {
		return fmt.Errorf("limits.max_concurrency must be between 1 and 64")
	}
	if c.Limits.MaxHeaderCount == 0 {
		c.Limits.MaxHeaderCount = 64
	}
	if c.Limits.MaxHeaderCount < 1 || c.Limits.MaxHeaderCount > HardMaxHeaderCount {
		return fmt.Errorf("limits.max_header_count must be between 1 and %d", HardMaxHeaderCount)
	}
	if c.Limits.MaxHeaderBytes == 0 {
		c.Limits.MaxHeaderBytes = 64 << 10
	}
	if c.Limits.MaxHeaderBytes < 1 || c.Limits.MaxHeaderBytes > HardMaxHeaderBytes {
		return fmt.Errorf("limits.max_header_bytes must be between 1 and %d", HardMaxHeaderBytes)
	}
	if c.Rate.RequestsPerSecond < 0 || c.Rate.RequestsPerSecond > 1000 {
		return fmt.Errorf("rate.requests_per_second must be between 0 and 1000")
	}
	if c.CircuitBreaker.Failures == 0 {
		c.CircuitBreaker.Failures = 3
	}
	if c.CircuitBreaker.Failures < 1 || c.CircuitBreaker.Failures > 100 {
		return fmt.Errorf("circuit_breaker.failures must be between 1 and 100")
	}
	if c.CircuitBreaker.OpenMS == 0 {
		c.CircuitBreaker.OpenMS = 30_000
	}
	if c.CircuitBreaker.OpenMS < 1 || c.CircuitBreaker.OpenMS > int64(time.Hour/time.Millisecond) {
		return fmt.Errorf("circuit_breaker.open_ms must be between 1 and 3600000")
	}
	for index := range c.Routes {
		route := &c.Routes[index]
		for _, header := range route.AllowedRequestHeaders {
			if _, secret := c.SecretHeaders[header]; secret {
				return fmt.Errorf("credential header %s cannot be supplied by Plugins", header)
			}
		}
	}
	return nil
}

func (r *RouteRule) normalize() error {
	r.Method = strings.ToUpper(strings.TrimSpace(r.Method))
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return fmt.Errorf("method %q is unsupported", r.Method)
	}
	if err := validateDecodedPath(r.PathPrefix); err != nil {
		return fmt.Errorf("path_prefix: %w", err)
	}
	var err error
	r.AllowedQueryNames, err = normalizeNames(r.AllowedQueryNames, false)
	if err != nil {
		return fmt.Errorf("allowed_query_names: %w", err)
	}
	r.AllowedRequestHeaders, err = normalizeNames(r.AllowedRequestHeaders, true)
	if err != nil {
		return fmt.Errorf("allowed_request_headers: %w", err)
	}
	for _, name := range r.AllowedRequestHeaders {
		if fixedForbiddenRequestHeaders[name] {
			return fmt.Errorf("request header %s is forbidden", name)
		}
	}
	r.AllowedResponseHeaders, err = normalizeNames(r.AllowedResponseHeaders, true)
	if err != nil {
		return fmt.Errorf("allowed_response_headers: %w", err)
	}
	for _, name := range r.AllowedResponseHeaders {
		if fixedForbiddenResponseHeaders[name] {
			return fmt.Errorf("response header %s is forbidden", name)
		}
	}
	if r.Cache.TTLMS < 0 || r.Cache.TTLMS > int64(time.Hour/time.Millisecond) {
		return fmt.Errorf("cache.ttl_ms must be between 0 and 3600000")
	}
	if r.Cache.TTLMS > 0 && !r.ReadOnly {
		return fmt.Errorf("cached routes must declare read_only")
	}
	if r.Retry.MaxRetries < 0 || r.Retry.MaxRetries > 3 {
		return fmt.Errorf("retry.max_retries must be between 0 and 3")
	}
	seenStatus := make(map[int]struct{}, len(r.Retry.Statuses))
	for _, status := range r.Retry.Statuses {
		if status < 100 || status > 599 {
			return fmt.Errorf("retry status %d is invalid", status)
		}
		if _, duplicate := seenStatus[status]; duplicate {
			return fmt.Errorf("retry status %d appears more than once", status)
		}
		seenStatus[status] = struct{}{}
	}
	r.Retry.IdempotencyHeader = strings.ToLower(strings.TrimSpace(r.Retry.IdempotencyHeader))
	if r.Retry.IdempotencyHeader != "" && !validHeaderName(r.Retry.IdempotencyHeader) {
		return fmt.Errorf("retry.idempotency_header is invalid")
	}
	if r.Retry.MaxRetries > 0 && !r.ReadOnly && r.Retry.IdempotencyHeader == "" {
		return fmt.Errorf("retrying a mutating route requires idempotency_header")
	}
	seenFailure := make(map[string]struct{}, len(r.Retry.Failures))
	for index, failure := range r.Retry.Failures {
		failure = strings.TrimSpace(failure)
		if failure != string(FailureUpstreamTimeout) && failure != string(FailureUpstreamUnreachable) {
			return fmt.Errorf("retry failure %q is unsupported", failure)
		}
		if _, duplicate := seenFailure[failure]; duplicate {
			return fmt.Errorf("retry failure %q appears more than once", failure)
		}
		seenFailure[failure] = struct{}{}
		r.Retry.Failures[index] = failure
	}
	return nil
}

func normalizeNames(values []string, header bool) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if header {
			value = strings.ToLower(value)
		}
		if value == "" || (header && !validHeaderName(value)) {
			return nil, fmt.Errorf("name %q is invalid", value)
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, fmt.Errorf("name %q appears more than once", value)
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	return normalized, nil
}
