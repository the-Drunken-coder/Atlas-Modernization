# Atlas Command Catalog Structure

This directory contains the Atlas Command Catalog, which defines all available commands that can be executed by Atlas assets.

## Command Catalog Structure

The command catalog is stored in [`command_catalog.json`](command_catalog.json) and follows this structure (illustrative — not strict JSON because of placeholder unions):

```text
{
  "type": "command_catalog",
  "name": "Atlas Command Catalog",
  "description": "Preset catalog that describes the commands available to Atlas assets.",
  "commands": [
    {
      "id": "COMMAND_ID",
      "name": "Command Name",
      "description": "Detailed description of what the command does.",
      "parameters_schema": {
        "parameter_name": {
          "type": "<string|number|boolean>",
          "description": "Description of what this parameter does.",
          "required": <true|false>,
          "minimum": <number>,
          "maximum": <number>
        }
      }
    }
  ]
}
```

Run `go test ./...`, `go run ./cmd/atlas_core`, and `python scripts/seed_command_catalog.py` from the **`Atlas_Core/`** module root (the directory that contains `go.mod`), not from this `command_catalog/` folder alone.

## Command Structure

Each command in the catalog must have the following structure:

### Required Fields

- **`id`** (string): Unique identifier for the command. It should be URL-safe, lowercase, and use underscores for word separation.
- **`name`** (string): Human-readable name for the command.
- **`description`** (string): Detailed description of what the command does and its purpose.
- **`parameters_schema`** (object): Schema defining the parameters this command accepts.

### Parameters Schema

The `parameters_schema` object defines the parameters that the command accepts:

- **Parameter Name** (string): The name of the parameter (used as the key in the schema object).
- **`type`** (string): The data type of the parameter. It can be: `string`, `number`, or `boolean`. Nested `object` and `array` parameters are intentionally not supported; seed script validation rejects unsupported types with the full parameter path, such as `$.commands[0].parameters_schema.latitude.type must be one of: boolean, number, string`.
- **`description`** (string): Description of what this parameter does and how it affects command execution.
- **`required`** (boolean): Whether this parameter is required (`true`) or optional (`false`).
- **`minimum`** (number, optional): Inclusive lower bound for numeric parameters such as latitude or longitude.
- **`maximum`** (number, optional): Inclusive upper bound for numeric parameters such as latitude or longitude.

### Example Command

```json
{
  "id": "adsb_monitoring",
  "name": "ADSB Monitoring",
  "description": "Monitor a geographic area for ADS-B traffic using a geofeature entity (polygon or circle shape).",
  "parameters_schema": {
    "geofeature_id": {
      "type": "string",
      "description": "The identifier of the geofeature entity to monitor. The geofeature must be a polygon or circle shape, not a point or line.",
      "required": true
    }
  }
}
```

## Validation

The command catalog JSON is validated when seeding via `scripts/seed_command_catalog.py` (structure, required fields, unique IDs). A focused Go test also guards protocol-sensitive schema details such as `move_to_location` using `altitude_m` — run `go test ./...` for general module health after editing `command_catalog.json`.

## Usage

The command catalog is used by the Atlas system to:

1. **Validate incoming commands** - Ensure only defined commands can be executed
2. **Provide command discovery** - Allow clients to discover available commands
3. **Parameter validation** - Validate command parameters against the schema
4. **Documentation** - Serve as a reference for available commands and their usage

## Adding New Commands

To add a new command to the catalog:

1. Add the command definition to the `commands` array in [`command_catalog.json`](command_catalog.json)
2. Ensure the command follows the structure defined above
3. From **`Atlas_Core/`**, run `go test ./...` and optionally re-seed: `python scripts/seed_command_catalog.py`
4. Update the seed script if needed: [`scripts/seed_command_catalog.py`](../scripts/seed_command_catalog.py)

## Best Practices

- **Command IDs**: Use descriptive, URL-safe lowercase identifiers with underscores (e.g., `move_to_location`, `take_photo`, `return_to_home`)
- **Parameter Names**: Use lowercase with underscores (e.g., `geofeature_id`, `altitude_meters`)
- **Descriptions**: Be detailed about what the command does and any constraints
- **Required Parameters**: Mark parameters as required only if they are essential for command execution
- **Type Safety**: Use specific types (e.g., `number` for numeric values, not `string`)

## Seeding the Catalog

The catalog can be seeded to the Atlas system using the seed script (from **`Atlas_Core/`**, same as `go test ./...`):

```bash
cd Atlas_Core
python scripts/seed_command_catalog.py --api-url http://localhost:8000
```

This uploads the catalog to the Atlas Core API and makes it available for command validation and discovery.

Go `*_test.go` tests cover the Go module; catalog JSON checks are performed by the seed script unless a dedicated catalog test is added later.
