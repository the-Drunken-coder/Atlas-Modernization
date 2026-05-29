# Multi-stage Dockerfile for ATLAS Core System (Go)
# Builder/dev: golang:1.26.1-alpine (digest-pinned linux/amd64 manifest). Production: slim alpine:3.21 runtime image.

# Build stage (keep digest aligned with Atlas_Core/go.mod `go` directive; refresh when bumping Go)
FROM golang:1.26.1-alpine@sha256:2389ebfa5b7f43eeafbd6be0c3700cc46690ef842ad962f6c5bd6be49ed82039 AS builder

# Alpine packages (base is alpine3.23); refresh versions when bumping the Go base image.
RUN apk add --no-cache git ca-certificates

# Set work directory
WORKDIR /app

# Allow automatic toolchain download when go.mod requires a newer Go than the base image.
ENV GOTOOLCHAIN=auto

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY cmd/ ./cmd/
COPY internal/ ./internal/

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o atlas_core ./cmd/atlas_core

# Development stage
FROM golang:1.26.1-alpine@sha256:d337ecb3075f0ec76d81652b3fa52af47c3eba6c8ba9f93b835752df7ce62946 AS development

# Alpine packages (match builder stage).
RUN apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

ENV GOTOOLCHAIN=auto

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code (for hot reload in development)
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# Use the committed example settings in containers; local overrides should be
# mounted at runtime (e.g., via docker compose override / bind mount).
COPY atlas_core.settings.json.example ./atlas_core.settings.json

# Change ownership to app user
RUN chown -R atlas:atlas /app

# Expose port
EXPOSE 8000

# Run development container as non-root user
USER atlas

# Run with go run for development (allows hot reload with volume mounts)
CMD ["go", "run", "./cmd/atlas_core"]

# Production stage (digest pins alpine:3.21 index; tag 3.21.6 as of 2026-01)
FROM alpine:3.21@sha256:c3f8e73fdb79deaebaa2037150150191b9dcbfba68b4a46d70103204c53f4709 AS production

# Runtime packages follow the digest-pinned base image; avoid revision pins that break rebuilds.
RUN apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/atlas_core .
COPY atlas_core.settings.json.example ./atlas_core.settings.json

# Change ownership to app user
RUN chown -R atlas:atlas /app
USER atlas

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["./atlas_core"]
