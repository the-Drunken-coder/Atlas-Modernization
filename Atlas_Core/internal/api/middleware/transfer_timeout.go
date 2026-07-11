package middleware

import (
	"io"
	"net/http"
	"time"
)

const transferWriteChunkSize = 32 * 1024

// TransferIdleTimeout replaces the server's absolute request/response deadlines
// with sliding idle deadlines for handlers that intentionally transfer large
// bodies. Header deadlines remain owned by http.Server.
func TransferIdleTimeout(idle time.Duration) func(http.Handler) http.Handler {
	return transferIdleTimeout(idle, time.Now)
}

func transferIdleTimeout(idle time.Duration, now func() time.Time) func(http.Handler) http.Handler {
	if idle <= 0 {
		panic("transfer idle timeout must be positive")
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			controller := http.NewResponseController(w)
			if err := controller.SetWriteDeadline(time.Time{}); err != nil {
				http.Error(w, "failed to configure transfer deadline", http.StatusInternalServerError)
				return
			}

			writer := &transferResponseWriter{
				ResponseWriter: w,
				controller:     controller,
				idle:           idle,
				now:            now,
			}
			if r.Body != nil && r.Body != http.NoBody {
				if err := controller.SetReadDeadline(now().Add(idle)); err != nil {
					http.Error(writer, "failed to configure transfer deadline", http.StatusInternalServerError)
					return
				}
				r.Body = &transferRequestBody{
					ReadCloser: r.Body,
					controller: controller,
					idle:       idle,
					now:        now,
				}
			}

			next.ServeHTTP(writer, r)
		})
	}
}

type transferRequestBody struct {
	io.ReadCloser
	controller *http.ResponseController
	idle       time.Duration
	now        func() time.Time
}

func (b *transferRequestBody) Read(p []byte) (int, error) {
	if err := b.controller.SetReadDeadline(b.now().Add(b.idle)); err != nil {
		return 0, err
	}
	return b.ReadCloser.Read(p)
}

type transferResponseWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
	idle       time.Duration
	now        func() time.Time
}

func (w *transferResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *transferResponseWriter) WriteHeader(statusCode int) {
	_ = w.controller.SetWriteDeadline(w.now().Add(w.idle))
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *transferResponseWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		if err := w.controller.SetWriteDeadline(w.now().Add(w.idle)); err != nil {
			return 0, err
		}
		n, err := w.ResponseWriter.Write(p)
		if err == nil {
			err = w.controller.SetWriteDeadline(w.now().Add(w.idle))
		}
		return n, err
	}

	written := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > transferWriteChunkSize {
			chunk = chunk[:transferWriteChunkSize]
		}
		if err := w.controller.SetWriteDeadline(w.now().Add(w.idle)); err != nil {
			return written, err
		}
		n, err := w.ResponseWriter.Write(chunk)
		written += n
		if err != nil {
			return written, err
		}
		if n != len(chunk) {
			return written, io.ErrShortWrite
		}
		if err := w.controller.SetWriteDeadline(w.now().Add(w.idle)); err != nil {
			return written, err
		}
		p = p[n:]
	}
	return written, nil
}
