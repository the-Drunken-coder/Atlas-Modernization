# Atlas Command Catalog

[`command_catalog.json`](command_catalog.json) is the authored catalog embedded in Atlas Core. Its wire shape is owned by Atlas Protocol as `CommandCatalog` in [`../../atlas_protocol/schema/jsonschema/atlas.schema.json`](../../atlas_protocol/schema/jsonschema/atlas.schema.json).

Core validates the embedded file at startup and uses the resulting typed catalog when it validates command tasks. The same exact JSON is available to clients at:

```text
GET /command-catalog
```

The endpoint includes a strong `ETag`; clients may use `If-None-Match`. The catalog is not an Atlas object, does not depend on MinIO, and does not produce resource-feed events. Updating it requires rebuilding and restarting Core.

## Editing the catalog

1. Change [`command_catalog.json`](command_catalog.json).
2. If the shape itself changes, update Atlas Protocol and regenerate its artifacts first.
3. Keep command IDs and parameter names in lowercase snake case.
4. Run:

   ```bash
   cd atlas_protocol
   go run ./tools/check
   go test ./...

   cd ../atlas_core
   go test ./command_catalog ./internal/api/handlers ./internal/actions
   ```

Protocol validation enforces the catalog structure and generated wire validators. Core's semantic validation additionally rejects duplicate command IDs, non-number bounds, and inverted numeric bounds.

Each command has this shape:

```json
{
  "id": "hold_position",
  "name": "Hold Position",
  "description": "Hold the current position.",
  "parameters_schema": {
    "seconds": {
      "type": "number",
      "description": "Optional hold duration.",
      "required": false,
      "minimum": 0
    }
  }
}
```

Supported parameter types are `string`, `number`, and `boolean`. `minimum` and `maximum` are valid only for numeric parameters.
