# Multi-stage Dockerfile for ATLAS Core System (Go)
# Production runtime: slim alpine:3.24. Go stages pin the Alpine Go image by digest.

# Compile on the runner's native architecture. Go emits the binary for each
# requested image platform without running the compiler through QEMU.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS builder

ARG TARGETOS
ARG TARGETARCH

# Alpine packages (base is alpine3.24); refresh versions when bumping the Go base image.
RUN apk add --no-cache git ca-certificates

# Set work directory
WORKDIR /app

# Allow automatic toolchain download when go.mod requires a newer Go than the base image.
ENV GOTOOLCHAIN=auto

# Copy go mod files first for better caching. The Docker build context is the
# repository root so Atlas Core can use the Protocol module.
COPY services/core/go.mod services/core/go.sum ./
COPY packages/protocol/go.mod /packages/protocol/go.mod
RUN go mod download

# Copy source code
COPY packages/protocol/ /packages/protocol/
COPY services/core/cmd/ ./cmd/
COPY services/core/internal/ ./internal/

# Build the binaries for the requested image platform.
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -ldflags="-w -s" -o atlas_core ./cmd/atlas_core && \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -ldflags="-w -s" -o atlas_source_gateway ./cmd/atlas_source_gateway

# Development stage: use the same multi-arch index digest as the builder stage.
FROM golang:1.27-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS development

# Alpine packages (match builder stage).
RUN apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

ENV GOTOOLCHAIN=auto

# Copy go mod files
COPY services/core/go.mod services/core/go.sum ./
COPY packages/protocol/go.mod /packages/protocol/go.mod
RUN go mod download

# Copy source code (for hot reload in development)
COPY packages/protocol/ /packages/protocol/
COPY services/core/cmd/ ./cmd/
COPY services/core/internal/ ./internal/
# Use the committed example settings only in development containers; local
# overrides should be mounted at runtime (e.g., via docker compose override /
# bind mount).
COPY services/core/atlas_core.settings.json.example ./atlas_core.settings.json

# Change ownership to app user
RUN chown -R atlas:atlas /app

# Expose port
EXPOSE 8000

# Run development container as non-root user
USER atlas

# Run with go run for development (allows hot reload with volume mounts)
CMD ["go", "run", "./cmd/atlas_core"]

FROM development AS source-gateway-development
COPY services/core/docker/source_gateway.development.json ./source_gateway.json
EXPOSE 8080
CMD ["go", "run", "./cmd/atlas_source_gateway"]

# Production stage (digest pins alpine:3.24 index)
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS production

# The pinned image is not rebuilt for later v3.24 security fixes, so refresh its base packages.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates curl

# Create app user
RUN addgroup -S atlas && adduser -S atlas -G atlas

# Set work directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/atlas_core .
COPY --from=builder /app/atlas_source_gateway .
COPY services/core/docker/production-entrypoint.sh ./production-entrypoint.sh

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

FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS source-gateway-production
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates curl
RUN addgroup -S atlas && adduser -S atlas -G atlas
WORKDIR /app
COPY --from=builder /app/atlas_source_gateway .
COPY services/core/docker/source_gateway.production.json ./source_gateway.json
RUN chown -R atlas:atlas /app
USER atlas
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
CMD ["./atlas_source_gateway"]
