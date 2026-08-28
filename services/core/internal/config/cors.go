package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// DefaultCORSOrigins are the default allowed origins for CORS.
var DefaultCORSOrigins = []string{
	"http://localhost:3000",
	"http://localhost:8080",
	"http://localhost:5173",
	"http://localhost:5175",
	"http://localhost:8787",
	"http://localhost:4173",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:8080",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:5175",
	"http://127.0.0.1:8787",
	"http://127.0.0.1:4173",
}

func parseCORSOriginsValue(raw string) ([]string, error) {
	return parseCORSListValue(raw, "CORS origins", validateCORSOrigins)
}

func parseCORSOriginPatternsValue(raw string) ([]string, error) {
	return parseCORSListValue(raw, "CORS origin patterns", validateCORSOriginPatterns)
}

func parseCORSListValue(raw string, label string, validate func([]string) error) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}, nil
	}

	if strings.HasPrefix(raw, "[") {
		var origins []string
		if err := json.Unmarshal([]byte(raw), &origins); err != nil {
			return nil, fmt.Errorf("%s: invalid JSON array: %w", label, err)
		}
		result := make([]string, 0, len(origins))
		for _, o := range origins {
			if trimmed := strings.TrimSpace(o); trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result, validate(result)
	}

	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result, validate(result)
}

func validateCORSOrigins(origins []string) error {
	for _, o := range origins {
		if strings.Contains(o, "*") {
			return fmt.Errorf("CORS origins: wildcard origin %q is not allowed; configure explicit origins", o)
		}
		if err := validateCORSOrigin(o); err != nil {
			return err
		}
	}
	return nil
}

func validateCORSOrigin(origin string) error {
	normalized := strings.TrimRight(strings.TrimSpace(origin), "/")
	if normalized == "" {
		return fmt.Errorf("CORS origins: empty origin is not allowed")
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("CORS origins: %q must be a full http(s) origin", origin)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("CORS origins: %q must use http or https", origin)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return fmt.Errorf("CORS origins: %q must not include user info, path, query, or fragment", origin)
	}
	return nil
}

func validateCORSOriginPatterns(patterns []string) error {
	for _, pattern := range patterns {
		if err := validateCORSOriginPattern(pattern); err != nil {
			return err
		}
	}
	return nil
}

func validateCORSOriginPattern(pattern string) error {
	normalized := strings.TrimRight(strings.TrimSpace(pattern), "/")
	if normalized == "" {
		return fmt.Errorf("CORS origin patterns: empty pattern is not allowed")
	}
	if strings.Count(normalized, "*") != 1 {
		return fmt.Errorf("CORS origin patterns: %q must contain exactly one wildcard", pattern)
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("CORS origin patterns: %q must be a full http(s) origin", pattern)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("CORS origin patterns: %q must use http or https", pattern)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return fmt.Errorf("CORS origin patterns: %q must not include user info, path, query, or fragment", pattern)
	}
	host := parsed.Hostname()
	if strings.Count(host, "*") != 1 || strings.Contains(parsed.Port(), "*") {
		return fmt.Errorf("CORS origin patterns: wildcard in %q must be in the hostname", pattern)
	}
	labels := strings.Split(host, ".")
	if len(labels) < 3 || !strings.Contains(labels[0], "*") {
		return fmt.Errorf("CORS origin patterns: wildcard in %q must be constrained to the leftmost hostname label", pattern)
	}
	if _, err := publicsuffix.EffectiveTLDPlusOne(strings.Join(labels[1:], ".")); err != nil {
		return fmt.Errorf("CORS origin patterns: wildcard in %q must not sit directly on a public suffix", pattern)
	}
	return nil
}
