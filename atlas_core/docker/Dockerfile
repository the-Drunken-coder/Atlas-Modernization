# Multi-stage Dockerfile for ATLAS Core System (Go)
# Production runtime: slim alpine:3.24. Go stages pin the Alpine Go image by digest.

# Build stage: multi-arch index digest (not the per-platform manifest SHA).
FROM golang:1.27rc3-alpine@sha256:c5aca77a4d16cb6688dbf3ccade67eff6f05ee208bc854d060e6947f5c27e23c AS builder

# Alpine packages (base is alpine3.24); refresh versions when bumping the Go base image.
RUN apk add --no-cache git ca-certificates

# Set work directory
WORKDIR /app

# Allow automatic toolchain download when go.mod requires a newer Go than the base image.
ENV GOTOOLCHAIN=auto

# Copy go mod files first for better caching. The Docker build context is the
# repository root so Atlas Core can use the sibling atlas_protocol module.
COPY atlas_core/go.mod atlas_core/go.sum ./
COPY atlas_protocol/go.mod /atlas_protocol/go.mod
RUN go mod download

# Copy source code
COPY atlas_protocol/ /atlas_protocol/
COPY atlas_core/cmd/ ./cmd/
COPY atlas_core/internal/ ./internal/

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o atlas_core ./cmd/atlas_core

# Development stage: use the same multi-arch index digest as the builder stage.
FROM golang:1.27rc3-alpine@sha256:c5aca77a4d16cb6688dbf3ccade67eff6f05ee208bc854d060e6947f5c27e23c AS development

# Alpine packages (match builder stage).
RUN apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

ENV GOTOOLCHAIN=auto

# Copy go mod files
COPY atlas_core/go.mod atlas_core/go.sum ./
COPY atlas_protocol/go.mod /atlas_protocol/go.mod
RUN go mod download

# Copy source code (for hot reload in development)
COPY atlas_protocol/ /atlas_protocol/
COPY atlas_core/cmd/ ./cmd/
COPY atlas_core/internal/ ./internal/
# Use the committed example settings only in development containers; local
# overrides should be mounted at runtime (e.g., via docker compose override /
# bind mount).
COPY atlas_core/atlas_core.settings.json.example ./atlas_core.settings.json

# Change ownership to app user
RUN chown -R atlas:atlas /app

# Expose port
EXPOSE 8000

# Run development container as non-root user
USER atlas

# Run with go run for development (allows hot reload with volume mounts)
CMD ["go", "run", "./cmd/atlas_core"]

# Production stage (digest pins alpine:3.24 index)
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS production

# Runtime packages follow the digest-pinned base image; avoid revision pins that break rebuilds.
RUN apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/atlas_core .
COPY atlas_core/docker/production-entrypoint.sh ./production-entrypoint.sh

# Change ownership to app user
RUN chown -R atlas:atlas /app && chmod 0500 /app/production-entrypoint.sh
USER atlas

# Expose port
EXPOSE 8000

# Operational readiness check for orchestrators and dependent services.
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/readiness || exit 1

ENTRYPOINT ["./production-entrypoint.sh"]
CMD ["./atlas_core"]
