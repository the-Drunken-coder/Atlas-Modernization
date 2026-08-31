# Source Gateway configuration

The Atlas Source Gateway is a private Compose service. It exposes `GET /health` and `POST /connectors/{connector_id}/requests` only on the deployment network. Start it with `go run ./cmd/atlas_source_gateway`. `ATLAS_SOURCE_GATEWAY_CONFIG` selects the base settings file and defaults to `source_gateway.json`. `ATLAS_SOURCE_CONNECTOR_CONFIG_DIR` selects the directory of connector fragments; an unset or empty directory configures no connectors.

Both settings and connector fragments are strict JSON. Connector fragments are loaded in filename order. Unknown fields, unsupported directory entries, invalid files, duplicate connector IDs or routes, invalid identifiers, unsafe origins, and invalid policy combinations prevent startup.

```json
{
  "listen_address": ":8080",
  "cache_max_entries": 1024,
  "cache_max_bytes": 33554432
}
```

Each file in the connector directory contains one connector:

```json
{
  "id": "example_source",
  "origin": "https://source.example",
  "routes": [
    {
      "method": "GET",
      "path_prefix": "/v1/items",
      "allowed_query_names": ["id"],
      "allowed_request_headers": ["accept-language"],
      "allowed_response_headers": ["content-type", "etag"],
      "read_only": true,
      "cache": { "ttl_ms": 0 },
      "retry": {
        "max_retries": 0,
        "statuses": [],
        "failures": [],
        "idempotency_header": ""
      }
    }
  ],
  "secret_headers": {
    "x-api-key": { "environment": "EXAMPLE_SOURCE_API_KEY", "prefix": "" }
  },
  "egress": {
    "allow_private": false,
    "allow_loopback": false,
    "allow_link_local": false
  },
  "limits": {
    "timeout_ms": 10000,
    "max_request_bytes": 262144,
    "max_response_bytes": 4194304,
    "max_concurrency": 4,
    "max_header_count": 64,
    "max_header_bytes": 65536
  },
  "rate": { "requests_per_second": 0 },
  "circuit_breaker": { "failures": 3, "open_ms": 30000 }
}
```

An origin pins scheme, host, and port and cannot contain credentials, a path, query, or fragment. The Gateway resolves and validates the selected address before connecting. Private, loopback, and link-local addresses are denied unless the connector explicitly allows that class. Redirects are returned to the Plugin and never followed.

Each route matches one method and decoded path prefix. The longest matching prefix wins. Query and header allowlists are case-sensitive for query names and case-insensitive for HTTP header names. Secret headers resolve at startup from either `environment` or `file`, never both, and Plugins cannot override them. Fixed credential and hop-by-hop headers are always removed even if listed.

Caching and retries are disabled when their zero values are used. A cached route must be read-only. `429` and `5xx` responses are never cached. Retrying a mutating route requires `idempotency_header`, and each request must supply it. Retry failures may contain only `upstream_timeout` and `upstream_unreachable`. A valid upstream HTTP response, including `3xx`, `4xx`, or `5xx`, is returned to the Plugin and resets the connector circuit.

The committed base development and production settings contain no connectors. A Plugin Compose overlay sets `ATLAS_SOURCE_CONNECTOR_CONFIG_DIR` and mounts its private connector fragment into that directory. The packaged `atlas-core` CLI stages enabled first-party Plugin fragments and includes their overlays automatically. Operators replacing the base production settings can use `${ATLAS_SOURCE_GATEWAY_CONFIG_FILE:-./source_gateway.production.json}`, but connectors still belong in the fragment directory. Secret references resolve from environment variables or files supplied to the Source Gateway container by the deployment. Credentials do not belong in connector configuration or Atlas resources.
