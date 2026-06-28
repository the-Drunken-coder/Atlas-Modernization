// Package commandcatalog loads and validates Atlas Core command definitions.
package commandcatalog

import (
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"sync"
)

//go:embed command_catalog.json
var catalogFS embed.FS

type Catalog struct {
	Type        string    `json:"type"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Commands    []Command `json:"commands"`
}

type Command struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Description      string                     `json:"description"`
	ParametersSchema map[string]ParameterSchema `json:"parameters_schema"`
}

type ParameterSchema struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Required    bool     `json:"required"`
	Minimum     *float64 `json:"minimum,omitempty"`
	Maximum     *float64 `json:"maximum,omitempty"`
}

var (
	defaultCatalog Catalog
	defaultErr     error
	defaultOnce    sync.Once
)

func Default() (Catalog, error) {
	defaultOnce.Do(func() {
		data, err := catalogFS.ReadFile("command_catalog.json")
		if err != nil {
			defaultErr = err
			return
		}
		defaultErr = json.Unmarshal(data, &defaultCatalog)
	})
	return defaultCatalog, defaultErr
}

func (c Catalog) Command(id string) (Command, bool) {
	for _, command := range c.Commands {
		if command.ID == id {
			return command, true
		}
	}
	return Command{}, false
}

func (c Command) CoerceParameters(raw any) (map[string]any, error) {
	params, ok := raw.(map[string]any)
	if raw == nil {
		params = map[string]any{}
		ok = true
	}
	if !ok {
		return nil, fmt.Errorf("parameters must be an object")
	}
	known := make(map[string]struct{}, len(c.ParametersSchema))
	for name := range c.ParametersSchema {
		known[name] = struct{}{}
	}
	for name := range params {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("unknown parameter %s", name)
		}
	}
	out := make(map[string]any, len(params))
	for name, schema := range c.ParametersSchema {
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

func coerceParameter(name string, schema ParameterSchema, value any) (any, error) {
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
