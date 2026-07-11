package middleware

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestTransferIdleTimeoutAllowsProgressPastAbsoluteTimeout(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.readDeadline = clock.Now().Add(30 * time.Second)
	writer.writeDeadline = clock.Now().Add(30 * time.Second)
	writer.writeDelays = []time.Duration{20 * time.Second, 20 * time.Second, 20 * time.Second}
	body := &deadlineTestBody{
		clock:  clock,
		writer: writer,
		chunks: [][]byte{[]byte("a"), []byte("b"), []byte("c")},
		delays: []time.Duration{20 * time.Second, 20 * time.Second, 20 * time.Second},
	}
	req := httptest.NewRequest(http.MethodPost, "/objects/upload", body)
	started := clock.Now()

	var readErr, writeErr error
	handler := transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
		for range 3 {
			if _, err := w.Write([]byte("x")); err != nil {
				writeErr = err
				return
			}
		}
	}))
	handler.ServeHTTP(writer, req)

	if readErr != nil || writeErr != nil {
		t.Fatalf("progressing transfer failed: read=%v write=%v", readErr, writeErr)
	}
	if elapsed := clock.Now().Sub(started); elapsed != 120*time.Second {
		t.Fatalf("elapsed = %s, want 2m", elapsed)
	}
	if len(writer.writeDeadlineCalls) == 0 || !writer.writeDeadlineCalls[0].IsZero() {
		t.Fatalf("first write deadline = %v, want inherited deadline cleared", writer.writeDeadlineCalls)
	}
	if got := writer.body.String(); got != "xxx" {
		t.Fatalf("response body = %q, want xxx", got)
	}
}

func TestTransferIdleTimeoutStopsIdleClientWriter(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	body := &deadlineTestBody{
		clock:  clock,
		writer: writer,
		chunks: [][]byte{[]byte("a")},
		delays: []time.Duration{31 * time.Second},
	}
	req := httptest.NewRequest(http.MethodPost, "/objects/upload", body)

	var readErr error
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	})).ServeHTTP(writer, req)

	if !errors.Is(readErr, os.ErrDeadlineExceeded) {
		t.Fatalf("read error = %v, want deadline exceeded", readErr)
	}
}

func TestTransferIdleTimeoutStopsIdleClientReader(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.writeDelays = []time.Duration{31 * time.Second}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/download", nil)

	var writeErr error
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, writeErr = w.Write([]byte("x"))
	})).ServeHTTP(writer, req)

	if !errors.Is(writeErr, os.ErrDeadlineExceeded) {
		t.Fatalf("write error = %v, want deadline exceeded", writeErr)
	}
}

func TestTransferIdleTimeoutRefreshesAfterSlowSuccessfulWrite(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.writeDelays = []time.Duration{29 * time.Second, 2 * time.Second}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/download", nil)

	var writeErr error
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, writeErr = w.Write([]byte("a")); writeErr == nil {
			_, writeErr = w.Write([]byte("b"))
		}
	})).ServeHTTP(writer, req)

	if writeErr != nil {
		t.Fatalf("second write after recent progress: %v", writeErr)
	}
	if got := writer.body.String(); got != "ab" {
		t.Fatalf("response body = %q, want ab", got)
	}
	want := time.Unix(1_700_000_000, 0).Add(59 * time.Second)
	if writer.writeDeadline.Before(want) {
		t.Fatalf("final write deadline = %v, want at least %v", writer.writeDeadline, want)
	}
}

func TestTransferIdleTimeoutAllowsContinuousProgressDuringOneLargeWrite(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.writeDelays = []time.Duration{20 * time.Second, 20 * time.Second, 20 * time.Second}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)
	payload := bytes.Repeat([]byte("x"), 3*transferWriteChunkSize)

	var n int
	var writeErr error
	started := clock.Now()
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n, writeErr = w.Write(payload)
	})).ServeHTTP(writer, req)

	if writeErr != nil {
		t.Fatalf("continuously progressing large write failed: %v", writeErr)
	}
	if n != len(payload) || writer.body.Len() != len(payload) {
		t.Fatalf("bytes written = %d (%d stored), want %d", n, writer.body.Len(), len(payload))
	}
	if elapsed := clock.Now().Sub(started); elapsed != time.Minute {
		t.Fatalf("elapsed = %s, want 1m", elapsed)
	}
}

func TestTransferIdleTimeoutStopsStalledChunkDuringLargeWrite(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.writeDelays = []time.Duration{20 * time.Second, 31 * time.Second}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)
	payload := bytes.Repeat([]byte("x"), 2*transferWriteChunkSize)

	n, err := 0, error(nil)
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n, err = w.Write(payload)
	})).ServeHTTP(writer, req)

	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("write error = %v, want deadline exceeded", err)
	}
	if n != transferWriteChunkSize {
		t.Fatalf("bytes written = %d, want %d", n, transferWriteChunkSize)
	}
}

func TestTransferIdleTimeoutPropagatesShortWrite(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	writer.writeLimits = []int{transferWriteChunkSize / 2}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)
	payload := bytes.Repeat([]byte("x"), transferWriteChunkSize+1)

	n, err := 0, error(nil)
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n, err = w.Write(payload)
	})).ServeHTTP(writer, req)

	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("write error = %v, want short write", err)
	}
	if n != transferWriteChunkSize/2 {
		t.Fatalf("bytes written = %d, want %d", n, transferWriteChunkSize/2)
	}
}

func TestTransferIdleTimeoutPropagatesWriteErrorAfterProgress(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	wantErr := errors.New("write failed")
	writer.writeLimits = []int{transferWriteChunkSize, 0}
	writer.writeErrors = []error{nil, wantErr}
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)
	payload := bytes.Repeat([]byte("x"), 2*transferWriteChunkSize)

	n, err := 0, error(nil)
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n, err = w.Write(payload)
	})).ServeHTTP(writer, req)

	if !errors.Is(err, wantErr) {
		t.Fatalf("write error = %v, want %v", err, wantErr)
	}
	if n != transferWriteChunkSize {
		t.Fatalf("bytes written = %d, want %d", n, transferWriteChunkSize)
	}
}

func TestTransferIdleTimeoutLeavesOrdinaryWriteWhole(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)
	payload := bytes.Repeat([]byte("x"), transferWriteChunkSize)

	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if n, err := w.Write(payload); err != nil || n != len(payload) {
			t.Fatalf("Write() = %d, %v, want %d, nil", n, err, len(payload))
		}
	})).ServeHTTP(writer, req)

	if writer.writeCalls != 1 {
		t.Fatalf("underlying write calls = %d, want 1", writer.writeCalls)
	}
}

func TestTransferIdleTimeoutPreservesBodyLimitAndContext(t *testing.T) {
	clock := &deadlineTestClock{current: time.Unix(1_700_000_000, 0)}
	writer := newDeadlineTestWriter(clock)
	body := &deadlineTestBody{
		clock:  clock,
		writer: writer,
		chunks: [][]byte{[]byte("abcd")},
		delays: []time.Duration{time.Second},
	}
	req := httptest.NewRequest(http.MethodPost, "/objects/upload", body)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	var readErr error
	transferIdleTimeout(30*time.Second, clock.Now)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !errors.Is(r.Context().Err(), context.Canceled) {
			t.Fatalf("request context error = %v, want context canceled", r.Context().Err())
		}
		r.Body = http.MaxBytesReader(w, r.Body, 3)
		_, readErr = io.ReadAll(r.Body)
		_ = r.Body.Close()
	})).ServeHTTP(writer, req)

	var maxBytesErr *http.MaxBytesError
	if !errors.As(readErr, &maxBytesErr) {
		t.Fatalf("read error = %T %v, want *http.MaxBytesError", readErr, readErr)
	}
	if !body.closed {
		t.Fatal("closing wrapped body did not close the original request body")
	}
}

func TestTransferIdleTimeoutRejectsUnsupportedDeadlineControl(t *testing.T) {
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/download", nil)
	called := false

	TransferIdleTimeout(30*time.Second)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	})).ServeHTTP(recorder, req)

	if called {
		t.Fatal("handler ran without connection deadline support")
	}
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestTransferIdleTimeoutOverridesRealServerWriteTimeout(t *testing.T) {
	handler := TransferIdleTimeout(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(60 * time.Millisecond)
		_, _ = w.Write([]byte("ok"))
	}))
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = 20 * time.Millisecond
	server.Start()
	t.Cleanup(server.Close)

	response, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatalf("GET after inherited write timeout: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(body) != "ok" {
		t.Fatalf("response body = %q, want ok", body)
	}
}

func TestTransferIdleTimeoutOverridesRealServerReadTimeout(t *testing.T) {
	handler := TransferIdleTimeout(time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(strconv.Itoa(len(body))))
	}))
	server := httptest.NewUnstartedServer(handler)
	server.Config.ReadTimeout = 20 * time.Millisecond
	server.Start()
	t.Cleanup(server.Close)

	reader, writer := io.Pipe()
	go func() {
		defer func() { _ = writer.Close() }()
		for range 4 {
			_, _ = writer.Write([]byte("x"))
			time.Sleep(20 * time.Millisecond)
		}
	}()
	response, err := server.Client().Post(server.URL, "application/octet-stream", reader)
	if err != nil {
		t.Fatalf("POST beyond inherited read timeout: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(body) != "4" {
		t.Fatalf("response body = %q, want 4", body)
	}
}

type deadlineTestClock struct {
	current time.Time
}

func (c *deadlineTestClock) Now() time.Time {
	return c.current
}

func (c *deadlineTestClock) advance(delay time.Duration) {
	c.current = c.current.Add(delay)
}

type deadlineTestWriter struct {
	header             http.Header
	clock              *deadlineTestClock
	readDeadline       time.Time
	writeDeadline      time.Time
	writeDeadlineCalls []time.Time
	writeDelays        []time.Duration
	writeLimits        []int
	writeErrors        []error
	writeCalls         int
	body               bytes.Buffer
	status             int
}

func newDeadlineTestWriter(clock *deadlineTestClock) *deadlineTestWriter {
	return &deadlineTestWriter{header: make(http.Header), clock: clock}
}

func (w *deadlineTestWriter) Header() http.Header {
	return w.header
}

func (w *deadlineTestWriter) WriteHeader(statusCode int) {
	w.status = statusCode
}

func (w *deadlineTestWriter) Write(p []byte) (int, error) {
	w.writeCalls++
	if w.status == 0 {
		w.status = http.StatusOK
	}
	delay := popDuration(&w.writeDelays)
	if deadlineExceeded(w.clock, w.writeDeadline, delay) {
		return 0, os.ErrDeadlineExceeded
	}
	w.clock.advance(delay)
	limit := len(p)
	if len(w.writeLimits) > 0 {
		limit = w.writeLimits[0]
		w.writeLimits = w.writeLimits[1:]
	}
	n, _ := w.body.Write(p[:min(limit, len(p))])
	if len(w.writeErrors) == 0 {
		return n, nil
	}
	err := w.writeErrors[0]
	w.writeErrors = w.writeErrors[1:]
	return n, err
}

func (w *deadlineTestWriter) SetReadDeadline(deadline time.Time) error {
	w.readDeadline = deadline
	return nil
}

func (w *deadlineTestWriter) SetWriteDeadline(deadline time.Time) error {
	w.writeDeadline = deadline
	w.writeDeadlineCalls = append(w.writeDeadlineCalls, deadline)
	return nil
}

type deadlineTestBody struct {
	clock  *deadlineTestClock
	writer *deadlineTestWriter
	chunks [][]byte
	delays []time.Duration
	closed bool
}

func (b *deadlineTestBody) Read(p []byte) (int, error) {
	if len(b.chunks) == 0 {
		return 0, io.EOF
	}
	delay := popDuration(&b.delays)
	if deadlineExceeded(b.clock, b.writer.readDeadline, delay) {
		return 0, os.ErrDeadlineExceeded
	}
	b.clock.advance(delay)
	chunk := b.chunks[0]
	b.chunks = b.chunks[1:]
	return copy(p, chunk), nil
}

func (b *deadlineTestBody) Close() error {
	b.closed = true
	return nil
}

func deadlineExceeded(clock *deadlineTestClock, deadline time.Time, delay time.Duration) bool {
	if deadline.IsZero() || !clock.Now().Add(delay).After(deadline) {
		return false
	}
	clock.current = deadline
	return true
}

func popDuration(values *[]time.Duration) time.Duration {
	if len(*values) == 0 {
		return 0
	}
	value := (*values)[0]
	*values = (*values)[1:]
	return value
}
