// Package integration provides integration tests for Atlas Core.
// These tests connect to a running local system and leave artifacts.
// Tests are skipped if the system is not running locally.
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
)

const (
	// DefaultAPIURL is the default URL for the Atlas Core API
	DefaultAPIURL = "http://localhost:8000"
)

// GetAPIURL returns the API URL from environment or default
func GetAPIURL() string {
	if envURL := os.Getenv("ATLAS_CORE_API_URL"); envURL != "" {
		return strings.TrimSuffix(envURL, "/")
	}
	return DefaultAPIURL
}

// joinURL safely joins a base URL with a path (preserves a non-empty base path prefix).
func joinURL(baseURL, path string) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid base URL %q: %w", baseURL, err)
	}
	query := ""
	if i := strings.Index(path, "?"); i >= 0 {
		query = path[i+1:]
		path = path[:i]
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return "", fmt.Errorf("invalid path %q: parent traversal is not allowed", path)
		}
	}
	prefix := strings.TrimSuffix(base.Path, "/")
	if prefix == "" {
		prefix = "/"
	}
	cleanedPath := pathpkg.Clean(path)
	if !strings.HasPrefix(cleanedPath, "/") {
		cleanedPath = "/" + cleanedPath
	}
	joined := pathpkg.Clean(prefix + cleanedPath)
	if joined == "" || joined[0] != '/' {
		joined = "/" + joined
	}
	base.Path = joined
	if query != "" {
		base.RawQuery = query
	}
	return base.String(), nil
}

// drainClose discards any unread response body bytes and closes the body.
func drainClose(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// SystemAvailable checks if the Atlas Core system is running
func SystemAvailable(t *testing.T) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	healthURL, err := joinURL(GetAPIURL(), "/health")
	if err != nil {
		t.Logf("Failed to construct health URL: %v", err)
		return false
	}
	resp, err := client.Get(healthURL)
	if err != nil {
		t.Logf("System not available: %v", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Logf("Health endpoint returned status %d", resp.StatusCode)
		return false
	}
	return true
}

// SkipIfSystemNotAvailable skips the test if system is not running
func SkipIfSystemNotAvailable(t *testing.T) {
	if !SystemAvailable(t) {
		t.Skip("Skipping integration test: Atlas Core system not running locally")
	}
}

// APIClient provides methods for interacting with the Atlas Core API
type APIClient struct {
	BaseURL string
	Client  *http.Client
}

// NewAPIClient creates a new API client
func NewAPIClient() *APIClient {
	return &APIClient{
		BaseURL: GetAPIURL(),
		Client:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Request makes an HTTP request to the API
func (c *APIClient) Request(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(jsonBytes)
	}

	fullURL, err := joinURL(c.BaseURL, path)
	if err != nil {
		return nil, fmt.Errorf("failed to construct URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
	if err != nil {
		return nil, err
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	return c.Client.Do(req)
}

// Get makes a GET request
func (c *APIClient) Get(ctx context.Context, path string) (*http.Response, error) {
	return c.Request(ctx, "GET", path, nil)
}

// Post makes a POST request
func (c *APIClient) Post(ctx context.Context, path string, body interface{}) (*http.Response, error) {
	return c.Request(ctx, "POST", path, body)
}

// Patch makes a PATCH request
func (c *APIClient) Patch(ctx context.Context, path string, body interface{}) (*http.Response, error) {
	return c.Request(ctx, "PATCH", path, body)
}

// Delete makes a DELETE request
func (c *APIClient) Delete(ctx context.Context, path string) (*http.Response, error) {
	return c.Request(ctx, "DELETE", path, nil)
}

// ParseResponse parses a JSON response body
func ParseResponse(resp *http.Response, v interface{}) error {
	return parseResponse(resp, v, false)
}

// ParseOptionalResponse parses a JSON response body and tolerates an empty body.
func ParseOptionalResponse(resp *http.Response, v interface{}) error {
	return parseResponse(resp, v, true)
}

func parseResponse(resp *http.Response, v interface{}, allowEmpty bool) error {
	if resp == nil || resp.Body == nil {
		return fmt.Errorf("nil HTTP response")
	}
	defer resp.Body.Close()

	err := jsondecode.Decode(json.NewDecoder(resp.Body), v)
	if err == nil {
		return nil
	}
	if allowEmpty && errors.Is(err, io.EOF) {
		return nil
	}
	if errors.Is(err, io.EOF) {
		return io.ErrUnexpectedEOF
	}
	return err
}

// TestArtifactPrefix returns a short unique prefix for test artifact IDs (max 50 chars with suffixes).
func TestArtifactPrefix() string {
	return fmt.Sprintf("it%x", time.Now().UnixNano())
}

// requireHTTPStatus fails the test if the response status is not want, then closes the body.
// On success, the body is left open for ParseResponse or other readers.
func requireHTTPStatus(t *testing.T, resp *http.Response, want int, label string) {
	t.Helper()
	if resp.StatusCode != want {
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		t.Fatalf("%s: want HTTP %d, got %d: %s", label, want, resp.StatusCode, string(b))
	}
}

func sliceContainsID(items []interface{}, field, id string) bool {
	for _, e := range items {
		m, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		if v, ok := m[field].(string); ok && v == id {
			return true
		}
	}
	return false
}
