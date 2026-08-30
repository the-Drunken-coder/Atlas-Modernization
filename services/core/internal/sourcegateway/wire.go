package sourcegateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/http/httpguts"
)

type FailureCode string

const (
	FailureRequestRejected     FailureCode = "request_rejected"
	FailureUnknownConnector    FailureCode = "unknown_connector"
	FailureResponseTooLarge    FailureCode = "response_too_large"
	FailureUpstreamUnreachable FailureCode = "upstream_unreachable"
	FailureCircuitOpen         FailureCode = "circuit_open"
	FailureUpstreamTimeout     FailureCode = "upstream_timeout"
)

type HeaderTuple [2]string

func (h *HeaderTuple) UnmarshalJSON(data []byte) error {
	var values []string
	if err := json.Unmarshal(data, &values); err != nil {
		return errors.New("tuple must contain two strings")
	}
	if len(values) != 2 {
		return errors.New("tuple must contain two strings")
	}
	h[0], h[1] = values[0], values[1]
	return nil
}

func (r *ConnectorRequest) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	required := []string{"method", "path", "query", "headers", "body_base64"}
	if len(fields) != len(required) {
		return errors.New("connector request must contain exactly the five documented fields")
	}
	for _, name := range required {
		if _, present := fields[name]; !present {
			return fmt.Errorf("connector request is missing %s", name)
		}
	}
	if err := json.Unmarshal(fields["method"], &r.Method); err != nil {
		return errors.New("method must be a string")
	}
	if err := json.Unmarshal(fields["path"], &r.Path); err != nil {
		return errors.New("path must be a string")
	}
	if err := json.Unmarshal(fields["query"], &r.Query); err != nil || r.Query == nil {
		return errors.New("query must be an array of two-string tuples")
	}
	if err := json.Unmarshal(fields["headers"], &r.Headers); err != nil || r.Headers == nil {
		return errors.New("headers must be an array of two-string tuples")
	}
	if string(fields["body_base64"]) == "null" {
		r.BodyBase64 = nil
		return nil
	}
	var body string
	if err := json.Unmarshal(fields["body_base64"], &body); err != nil {
		return errors.New("body_base64 must be a string or null")
	}
	if body == "" {
		return errors.New("body_base64 must be null for an empty body")
	}
	r.BodyBase64 = &body
	return nil
}

type ConnectorRequest struct {
	Method     string        `json:"method"`
	Path       string        `json:"path"`
	Query      []HeaderTuple `json:"query"`
	Headers    []HeaderTuple `json:"headers"`
	BodyBase64 *string       `json:"body_base64"`
}

type ConnectorResponse struct {
	Status     int           `json:"status"`
	Headers    []HeaderTuple `json:"headers"`
	BodyBase64 string        `json:"body_base64"`
}

type FailureResponse struct {
	Code FailureCode `json:"code"`
}

func decodeRequest(body io.Reader) (ConnectorRequest, error) {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	var request ConnectorRequest
	if err := decoder.Decode(&request); err != nil {
		return ConnectorRequest{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ConnectorRequest{}, errors.New("request must contain one JSON object")
	}
	return request, nil
}

func encodeJSON(value any, limit int64) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&limitedWriter{writer: &buffer, remaining: limit})
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.remaining {
		return 0, errWireTooLarge
	}
	w.remaining -= int64(len(data))
	return w.writer.Write(data)
}

var errWireTooLarge = errors.New("encoded response exceeds hard limit")

func validHeaderName(name string) bool {
	return name != "" && httpguts.ValidHeaderFieldName(name)
}

func validHeaderValue(value string) bool { return httpguts.ValidHeaderFieldValue(value) }

var hopByHopHeaders = map[string]bool{
	"connection": true, "content-length": true, "keep-alive": true,
	"proxy-authenticate": true, "proxy-authorization": true,
	"proxy-connection": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true,
}

var fixedForbiddenRequestHeaders = func() map[string]bool {
	result := cloneHeaderSet(hopByHopHeaders)
	for _, name := range []string{"host", "authorization", "cookie"} {
		result[name] = true
	}
	return result
}()

var fixedForbiddenResponseHeaders = func() map[string]bool {
	result := cloneHeaderSet(hopByHopHeaders)
	for _, name := range []string{"authorization", "cookie", "set-cookie"} {
		result[name] = true
	}
	return result
}()

func cloneHeaderSet(input map[string]bool) map[string]bool {
	result := make(map[string]bool, len(input))
	for name, value := range input {
		result[name] = value
	}
	return result
}

func validateDecodedPath(path string) error {
	if !utf8.ValidString(path) || !strings.HasPrefix(path, "/") {
		return errors.New("must be decoded UTF-8 text beginning with /")
	}
	if strings.ContainsAny(path, "\x00\\?#") || strings.HasPrefix(path, "//") {
		return errors.New("must not contain an authority, query, fragment, NUL, or backslash")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return errors.New("must not contain . or .. segments")
		}
	}
	return nil
}

func requireHeaderBudget(tuples []HeaderTuple, maxCount int, maxBytes int64) error {
	if len(tuples) > maxCount {
		return fmt.Errorf("header tuple count exceeds %d", maxCount)
	}
	var size int64
	for _, tuple := range tuples {
		if !utf8.ValidString(tuple[0]) || !utf8.ValidString(tuple[1]) || !validHeaderValue(tuple[1]) {
			return errors.New("headers must contain UTF-8 text")
		}
		size += int64(len(tuple[0]) + len(tuple[1]))
	}
	if size > maxBytes {
		return fmt.Errorf("header bytes exceed %d", maxBytes)
	}
	return nil
}
