package validator

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"cuelang.org/go/cue"
	"cuelang.org/go/cue/cuecontext"
	cueerrors "cuelang.org/go/cue/errors"
	"cuelang.org/go/cue/load"
	protocolschema "github.com/the-drunken-coder/atlas/atlas_protocol/schema"
)

const (
	modulePath = "github.com/the-drunken-coder/atlas/atlas_protocol"
	moduleRoot = "/atlas_protocol"
)

type compiledSchema struct {
	ctx  *cue.Context
	root cue.Value
}

var compiled struct {
	once   sync.Once
	schema *compiledSchema
	err    error
}

// evalMu serializes CUE evaluation. The CUE evaluator lazily mutates shared
// state inside cue.Value, so concurrent Unify/Validate calls against the
// shared compiled schema race without it.
var evalMu sync.Mutex

func ValidateEntityBlob(value any) []string {
	return validate("#EntityBlob", value)
}

func ValidateTaskBlob(value any) []string {
	return validate("#TaskBlob", value)
}

func ValidateObjectBlob(value any) []string {
	return validate("#ObjectBlob", value)
}

func ValidateEntityComponents(value any) []string {
	return validate("#EntityComponents", value)
}

func ValidateTaskComponents(value any) []string {
	return validate("#TaskComponents", value)
}

func ValidateCommandComponent(value any) []string {
	return validate("#CommandComponent", value)
}

func ValidateTaskParametersComponent(value any, fieldPrefix string) []string {
	return prefixErrors(validate("#TaskParametersComponent", value), fieldPrefix)
}

func ValidateTaskProgressComponent(value any) []string {
	return validate("#TaskProgressComponent", value)
}

func ValidateTaskCatalogComponent(value any) []string {
	return validate("#TaskCatalogComponent", value)
}

func ValidateMediaRefsComponent(value any) []string {
	return validate("#MediaRefsComponent", value)
}

func ValidateMilViewComponent(value any) []string {
	return validate("#MilViewComponent", value)
}

func ValidateHealthComponent(value any) []string {
	return validate("#HealthComponent", value)
}

func ValidateSensorRefsComponent(value any) []string {
	return validate("#SensorRefsComponent", value)
}

func ValidateCommunicationsComponent(value any) []string {
	return validate("#CommunicationsComponent", value)
}

func ValidateTaskQueueComponent(value any) []string {
	return validate("#TaskQueueComponent", value)
}

func ValidateStatusComponent(value any) []string {
	return validate("#StatusComponent", value)
}

func ValidateHeartbeatComponent(value any) []string {
	return validate("#HeartbeatComponent", value)
}

func ValidateTelemetryComponent(value any) []string {
	return validate("#TelemetryComponent", value)
}

func ValidateGeometryComponent(value any) []string {
	return validate("#GeometryComponent", value)
}

func validate(definition string, value any) []string {
	normalized, err := normalizeForCUE(value)
	if err != nil {
		return []string{fmt.Sprintf("input cannot be decoded as JSON: %v", err)}
	}
	if path, ok := firstNonFinitePath(normalized, ""); ok {
		if path == "" {
			path = "value"
		}
		return []string{path + ": must be finite"}
	}
	if errors := unknownComponentErrors(definition, normalized); len(errors) > 0 {
		return errors
	}

	schema, err := getSchema()
	if err != nil {
		return []string{fmt.Sprintf("protocol schema load failed: %v", err)}
	}

	path := cue.ParsePath(definition)
	if err := path.Err(); err != nil {
		return []string{fmt.Sprintf("invalid protocol schema path %q: %v", definition, err)}
	}

	evalMu.Lock()
	defer evalMu.Unlock()
	def := schema.root.LookupPath(path)
	if err := def.Err(); err != nil {
		return []string{fmt.Sprintf("protocol schema definition %s not found: %v", definition, err)}
	}

	input := schema.ctx.Encode(normalized)
	if err := input.Err(); err != nil {
		return []string{fmt.Sprintf("input cannot be encoded as CUE: %v", err)}
	}
	validated := def.Unify(input)
	if err := validated.Validate(cue.Concrete(true)); err != nil {
		return cueErrorMessages(err)
	}
	return nil
}

var knownEntityComponents = map[string]struct{}{
	"telemetry":      {},
	"geometry":       {},
	"task_catalog":   {},
	"media_refs":     {},
	"mil_view":       {},
	"health":         {},
	"sensor_refs":    {},
	"communications": {},
	"task_queue":     {},
	"status":         {},
	"heartbeat":      {},
}

var knownTaskComponents = map[string]struct{}{
	"command":        {},
	"parameters":     {},
	"progress":       {},
	"target":         {},
	"status_message": {},
}

func unknownComponentErrors(definition string, value any) []string {
	switch definition {
	case "#EntityBlob":
		blob, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		return componentUnknowns(blob["components"], knownEntityComponents)
	case "#TaskBlob":
		blob, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		return componentUnknowns(blob["components"], knownTaskComponents)
	case "#EntityComponents":
		return componentUnknowns(value, knownEntityComponents)
	case "#TaskComponents":
		return componentUnknowns(value, knownTaskComponents)
	default:
		return nil
	}
}

func componentUnknowns(value any, known map[string]struct{}) []string {
	components, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	var errors []string
	for key := range components {
		if _, ok := known[key]; ok || strings.HasPrefix(key, "custom_") {
			continue
		}
		errors = append(errors, fmt.Sprintf("Unknown component '%s'", key))
	}
	sort.Strings(errors)
	return errors
}

func getSchema() (*compiledSchema, error) {
	compiled.once.Do(func() {
		compiled.schema, compiled.err = loadSchema()
	})
	return compiled.schema, compiled.err
}

func loadSchema() (*compiledSchema, error) {
	overlay, err := schemaOverlay()
	if err != nil {
		return nil, err
	}

	instances := load.Instances([]string{"./schema"}, &load.Config{
		Dir:        moduleRoot,
		ModuleRoot: moduleRoot,
		Module:     modulePath,
		Package:    "atlasprotocol",
		Overlay:    overlay,
	})
	if len(instances) != 1 {
		return nil, fmt.Errorf("load returned %d schema instances", len(instances))
	}
	inst := instances[0]
	if inst.Err != nil {
		return nil, inst.Err
	}
	if inst.Incomplete {
		return nil, fmt.Errorf("schema imports are incomplete: %v", inst.DepsErrors)
	}

	ctx := cuecontext.New()
	root := ctx.BuildInstance(inst)
	if err := root.Err(); err != nil {
		return nil, err
	}
	return &compiledSchema{ctx: ctx, root: root}, nil
}

func schemaOverlay() (map[string]load.Source, error) {
	overlay := map[string]load.Source{
		filepath.Join(moduleRoot, "cue.mod", "module.cue"): load.FromString(`module: "` + modulePath + `"
language: {
	version: "v0.16.1"
}
`),
	}
	err := fs.WalkDir(protocolschema.Files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".cue") {
			return nil
		}
		content, err := protocolschema.Files.ReadFile(path)
		if err != nil {
			return err
		}
		overlay[filepath.Join(moduleRoot, "schema", filepath.FromSlash(path))] = load.FromBytes(content)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("build schema overlay: %w", err)
	}
	return overlay, nil
}

func cueErrorMessages(err error) []string {
	cueErrs := cueerrors.Errors(err)
	if len(cueErrs) == 0 {
		return []string{strings.TrimSpace(err.Error())}
	}

	messages := make([]string, 0, len(cueErrs))
	for _, cueErr := range cueErrs {
		message := strings.TrimSpace(cueerrors.String(cueErr))
		if message == "" {
			continue
		}
		messages = append(messages, message)
	}
	sort.Strings(messages)
	if len(messages) == 0 {
		return []string{strings.TrimSpace(err.Error())}
	}
	return messages
}

func prefixErrors(errors []string, fieldPrefix string) []string {
	fieldPrefix = strings.TrimSpace(fieldPrefix)
	if fieldPrefix == "" {
		return errors
	}
	fieldPrefix = strings.TrimSuffix(fieldPrefix, ".")

	prefixed := make([]string, 0, len(errors))
	for _, message := range errors {
		if message == "" {
			continue
		}
		message = strings.TrimPrefix(message, "#TaskParametersComponent.")
		message = strings.TrimPrefix(message, "#TaskParametersComponent")
		prefixed = append(prefixed, fieldPrefix+"."+message)
	}
	return prefixed
}

// normalizeForCUE converts Go JSON decode artifacts into values CUE can unify.
// encoding/json with UseNumber leaves numeric fields as json.Number, which CUE
// encodes as strings unless they are normalized to int64 or float64 first.
func normalizeForCUE(value any) (any, error) {
	switch typed := value.(type) {
	case json.RawMessage:
		return decodeRawJSON(typed)
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return i, nil
		}
		f, err := typed.Float64()
		if err != nil {
			return typed.String(), nil
		}
		return f, nil
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			normalized, err := normalizeForCUE(item)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			normalized, err := normalizeForCUE(item)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	default:
		return value, nil
	}
}

func decodeRawJSON(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON value")
		}
		return nil, err
	}
	return normalizeForCUE(value)
}

func firstNonFinitePath(value any, path string) (string, bool) {
	switch typed := value.(type) {
	case float64:
		return path, math.IsNaN(typed) || math.IsInf(typed, 0)
	case float32:
		return path, math.IsNaN(float64(typed)) || math.IsInf(float64(typed), 0)
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			if found, ok := firstNonFinitePath(typed[key], childPath); ok {
				return found, true
			}
		}
	case []any:
		for i, item := range typed {
			childPath := fmt.Sprintf("%s[%d]", path, i)
			if path == "" {
				childPath = fmt.Sprintf("[%d]", i)
			}
			if found, ok := firstNonFinitePath(item, childPath); ok {
				return found, true
			}
		}
	}
	return "", false
}
