// Package commandcatalog loads and validates Atlas Core command definitions.
package commandcatalog

import (
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

//go:embed command_catalog.json
var catalogFS embed.FS

var (
	catalogData    []byte
	catalogETag    string
	defaultCatalog protocol.CommandCatalog
	defaultErr     error
	defaultOnce    sync.Once
)

// JSON returns the command catalog embedded in the Core binary.
func JSON() ([]byte, error) {
	loadDefault()
	return append([]byte(nil), catalogData...), defaultErr
}

func ETag() (string, error) {
	loadDefault()
	return catalogETag, defaultErr
}

func Default() (protocol.CommandCatalog, error) {
	loadDefault()
	return defaultCatalog, defaultErr
}

func loadDefault() {
	defaultOnce.Do(func() {
		data, err := catalogFS.ReadFile("command_catalog.json")
		if err != nil {
			defaultErr = err
			return
		}
		if errors := protocol.ValidateCommandCatalog(json.RawMessage(data)); len(errors) > 0 {
			defaultErr = fmt.Errorf("invalid embedded command catalog: %s", strings.Join(errors, "; "))
			return
		}
		if err := json.Unmarshal(data, &defaultCatalog); err != nil {
			defaultErr = err
			return
		}
		catalogData = data
		catalogETag = fmt.Sprintf(`"%x"`, sha256.Sum256(data))
	})
}

func Command(catalog protocol.CommandCatalog, id string) (protocol.CommandDefinition, bool) {
	for _, command := range catalog.Commands {
		if command.ID == id {
			return command, true
		}
	}
	return protocol.CommandDefinition{}, false
}

func CoerceParameters(command protocol.CommandDefinition, raw any) (map[string]any, error) {
	params, ok := raw.(map[string]any)
	if raw == nil {
		params = map[string]any{}
		ok = true
	}
	if !ok {
		return nil, fmt.Errorf("parameters must be an object")
	}
	known := make(map[string]struct{}, len(command.ParametersSchema))
	for name := range command.ParametersSchema {
		known[name] = struct{}{}
	}
	for name := range params {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("unknown parameter %s", name)
		}
	}
	out := make(map[string]any, len(params))
	for name, schema := range command.ParametersSchema {
		value, exists := params[name]
		if emptyOptional(value, exists) {
			if schema.Required {
				return nil, fmt.Errorf("%s is required", name)
			}
			continue
		}
		coerced, err := coerceParameter(name, schema, value)
		if err != nil {
			return nil, err
		}
		out[name] = coerced
	}
	return out, nil
}

func coerceParameter(name string, schema protocol.CommandParameterSchema, value any) (any, error) {
	switch schema.Type {
	case "string":
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be a string", name)
		}
		return text, nil
	case "boolean":
		if value == true || value == false {
			return value, nil
		}
		if value == "true" {
			return true, nil
		}
		if value == "false" {
			return false, nil
		}
		return nil, fmt.Errorf("%s must be a boolean", name)
	case "number":
		number, err := finiteNumber(value)
		if err != nil {
			return nil, fmt.Errorf("%s must be a finite number", name)
		}
		if schema.Minimum != nil && number < *schema.Minimum {
			return nil, fmt.Errorf("%s must be >= %v", name, *schema.Minimum)
		}
		if schema.Maximum != nil && number > *schema.Maximum {
			return nil, fmt.Errorf("%s must be <= %v", name, *schema.Maximum)
		}
		return number, nil
	default:
		return nil, fmt.Errorf("%s has unsupported parameter type %s", name, schema.Type)
	}
}

func finiteNumber(value any) (float64, error) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, err
		}
		number = parsed
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		if err != nil {
			return 0, err
		}
		number = parsed
	default:
		return 0, fmt.Errorf("not a number")
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, fmt.Errorf("not finite")
	}
	return number, nil
}

func emptyOptional(value any, exists bool) bool {
	return !exists || value == nil || value == ""
}
