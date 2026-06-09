package artifacts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"text/template"
)

const cueVersion = "v0.16.1"

type Meta struct {
	EntityComponentKeys  []string `json:"entityComponentKeys"`
	TaskComponentKeys    []string `json:"taskComponentKeys"`
	GeoJSONTypes         []string `json:"geoJSONTypes"`
	MaxGeometryPositions int      `json:"maxGeometryPositions"`
}

type Artifact struct {
	Path    string
	Content []byte
}

func Generate(root string, write bool) ([]string, error) {
	if err := ValidateExamples(root); err != nil {
		return nil, err
	}

	meta, err := LoadMeta(root)
	if err != nil {
		return nil, err
	}

	artifacts, err := BuildArtifacts(root, meta)
	if err != nil {
		return nil, err
	}

	var drift []string
	for _, artifact := range artifacts {
		path := filepath.Join(root, filepath.FromSlash(artifact.Path))
		if write {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(path, artifact.Content, 0o644); err != nil {
				return nil, err
			}
			continue
		}

		current, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				drift = append(drift, artifact.Path)
				continue
			}
			return nil, fmt.Errorf("read existing artifact %s: %w", artifact.Path, err)
		}
		if !bytes.Equal(current, artifact.Content) {
			drift = append(drift, artifact.Path)
		}
	}

	return drift, nil
}

func ValidateExamples(root string) error {
	if err := validateExampleSet(root, "entities", "#EntityBlob"); err != nil {
		return err
	}
	if err := validateExampleSet(root, "tasks", "#TaskBlob"); err != nil {
		return err
	}
	return validateExampleSet(root, "objects", "#ObjectBlob")
}

func validateExampleSet(root, name, schema string) error {
	examples, err := filepath.Glob(filepath.Join(root, "examples", name, "*.json"))
	if err != nil {
		return err
	}
	if len(examples) == 0 {
		return fmt.Errorf("no %s examples found", name)
	}
	sort.Strings(examples)

	args := []string{"vet", "./schema"}
	for _, example := range examples {
		rel, err := filepath.Rel(root, example)
		if err != nil {
			return err
		}
		args = append(args, filepath.ToSlash(rel))
	}
	args = append(args, "-d", schema)

	_, err = runCue(root, args...)
	return err
}

func LoadMeta(root string) (Meta, error) {
	out, err := runCue(root, "export", "./schema", "-e", "#Meta")
	if err != nil {
		return Meta{}, err
	}

	var meta Meta
	if err := json.Unmarshal(out, &meta); err != nil {
		return Meta{}, err
	}
	if len(meta.EntityComponentKeys) == 0 {
		return Meta{}, fmt.Errorf("protocol metadata has no entity component keys")
	}
	if len(meta.TaskComponentKeys) == 0 {
		return Meta{}, fmt.Errorf("protocol metadata has no task component keys")
	}
	if meta.MaxGeometryPositions < 1 {
		return Meta{}, fmt.Errorf("protocol metadata has invalid maxGeometryPositions: %d", meta.MaxGeometryPositions)
	}
	return meta, nil
}

func BuildArtifacts(root string, meta Meta) ([]Artifact, error) {
	entitySchema, err := jsonSchema(root, "#EntityBlob")
	if err != nil {
		return nil, err
	}
	telemetrySchema, err := jsonSchema(root, "#TelemetryComponent")
	if err != nil {
		return nil, err
	}
	geometrySchema, err := jsonSchema(root, "#GeometryComponent")
	if err != nil {
		return nil, err
	}
	taskCatalogSchema, err := jsonSchema(root, "#TaskCatalogComponent")
	if err != nil {
		return nil, err
	}
	mediaRefsSchema, err := jsonSchema(root, "#MediaRefsComponent")
	if err != nil {
		return nil, err
	}
	milViewSchema, err := jsonSchema(root, "#MilViewComponent")
	if err != nil {
		return nil, err
	}
	healthSchema, err := jsonSchema(root, "#HealthComponent")
	if err != nil {
		return nil, err
	}
	sensorRefsSchema, err := jsonSchema(root, "#SensorRefsComponent")
	if err != nil {
		return nil, err
	}
	communicationsSchema, err := jsonSchema(root, "#CommunicationsComponent")
	if err != nil {
		return nil, err
	}
	taskQueueSchema, err := jsonSchema(root, "#TaskQueueComponent")
	if err != nil {
		return nil, err
	}
	statusSchema, err := jsonSchema(root, "#StatusComponent")
	if err != nil {
		return nil, err
	}
	heartbeatSchema, err := jsonSchema(root, "#HeartbeatComponent")
	if err != nil {
		return nil, err
	}
	entitySchema, err = hydrateEntityComponentDefs(
		entitySchema,
		telemetrySchema,
		geometrySchema,
		taskCatalogSchema,
		mediaRefsSchema,
		milViewSchema,
		healthSchema,
		sensorRefsSchema,
		communicationsSchema,
		taskQueueSchema,
		statusSchema,
		heartbeatSchema,
	)
	if err != nil {
		return nil, err
	}
	taskSchema, err := jsonSchema(root, "#TaskBlob")
	if err != nil {
		return nil, err
	}
	commandSchema, err := jsonSchema(root, "#CommandComponent")
	if err != nil {
		return nil, err
	}
	taskParametersSchema, err := jsonSchema(root, "#TaskParametersComponent")
	if err != nil {
		return nil, err
	}
	taskProgressSchema, err := jsonSchema(root, "#TaskProgressComponent")
	if err != nil {
		return nil, err
	}
	objectSchema, err := jsonSchema(root, "#ObjectBlob")
	if err != nil {
		return nil, err
	}
	objectReferenceSchema, err := jsonSchema(root, "#ObjectReference")
	if err != nil {
		return nil, err
	}
	goSource, err := generatedGo(meta)
	if err != nil {
		return nil, err
	}

	return []Artifact{
		{Path: "generated/jsonschema/entity.schema.json", Content: entitySchema},
		{Path: "generated/jsonschema/task.schema.json", Content: taskSchema},
		{Path: "generated/jsonschema/object.schema.json", Content: objectSchema},
		{Path: "generated/jsonschema/components/telemetry.schema.json", Content: telemetrySchema},
		{Path: "generated/jsonschema/components/geometry.schema.json", Content: geometrySchema},
		{Path: "generated/jsonschema/components/task-catalog.schema.json", Content: taskCatalogSchema},
		{Path: "generated/jsonschema/components/media-refs.schema.json", Content: mediaRefsSchema},
		{Path: "generated/jsonschema/components/mil-view.schema.json", Content: milViewSchema},
		{Path: "generated/jsonschema/components/health.schema.json", Content: healthSchema},
		{Path: "generated/jsonschema/components/sensor-refs.schema.json", Content: sensorRefsSchema},
		{Path: "generated/jsonschema/components/communications.schema.json", Content: communicationsSchema},
		{Path: "generated/jsonschema/components/task-queue.schema.json", Content: taskQueueSchema},
		{Path: "generated/jsonschema/components/status.schema.json", Content: statusSchema},
		{Path: "generated/jsonschema/components/heartbeat.schema.json", Content: heartbeatSchema},
		{Path: "generated/jsonschema/components/command.schema.json", Content: commandSchema},
		{Path: "generated/jsonschema/components/task-parameters.schema.json", Content: taskParametersSchema},
		{Path: "generated/jsonschema/components/task-progress.schema.json", Content: taskProgressSchema},
		{Path: "generated/jsonschema/components/object-reference.schema.json", Content: objectReferenceSchema},
		{Path: "generated/go/atlasprotocol/protocol.generated.go", Content: goSource},
	}, nil
}

func jsonSchema(root, expr string) ([]byte, error) {
	args := []string{"def", "./schema", "--out=jsonschema", "-e", expr}
	out, err := runCue(root, args...)
	if err != nil {
		return nil, err
	}
	return markGeneratedJSONSchema(out)
}

func markGeneratedJSONSchema(schema []byte) ([]byte, error) {
	var root map[string]any
	if err := json.Unmarshal(schema, &root); err != nil {
		return nil, err
	}
	root["$comment"] = "Code generated by go run ./tools/generate; DO NOT EDIT."
	patchGeneratedJSONSchema(root)

	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func hydrateEntityComponentDefs(entitySchema []byte, componentSchemas ...[]byte) ([]byte, error) {
	var entityRoot map[string]any
	if err := json.Unmarshal(entitySchema, &entityRoot); err != nil {
		return nil, fmt.Errorf("parse entity schema: %w", err)
	}
	entityDefs, err := schemaDefs(entityRoot, "entity schema")
	if err != nil {
		return nil, err
	}

	for _, componentSchema := range componentSchemas {
		var componentRoot map[string]any
		if err := json.Unmarshal(componentSchema, &componentRoot); err != nil {
			return nil, fmt.Errorf("parse component schema: %w", err)
		}
		componentDefs, err := schemaDefs(componentRoot, "component schema")
		if err != nil {
			return nil, err
		}

		for key, value := range componentDefs {
			existing, exists := entityDefs[key]
			if !exists {
				entityDefs[key] = value
				continue
			}
			if isSelfRefDef(key, existing) {
				if isSelfRefDef(key, value) {
					return nil, fmt.Errorf("component schema definition %s is still self-referential", key)
				}
				entityDefs[key] = value
				continue
			}
			if !reflect.DeepEqual(existing, value) {
				return nil, fmt.Errorf("conflicting JSON schema definition %s", key)
			}
		}
	}

	patchGeneratedJSONSchema(entityRoot)
	out, err := json.MarshalIndent(entityRoot, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func schemaDefs(root map[string]any, name string) (map[string]any, error) {
	defs, ok := root["$defs"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s has no $defs object", name)
	}
	return defs, nil
}

func isSelfRefDef(key string, value any) bool {
	node, ok := value.(map[string]any)
	if !ok || len(node) != 1 {
		return false
	}
	ref, ok := node["$ref"].(string)
	if !ok {
		return false
	}
	return ref == "#/$defs/%23"+strings.TrimPrefix(key, "#")
}

func patchGeneratedJSONSchema(root map[string]any) {
	normalizeArrayLengthKeywords(root)
	normalizeWildcardPatternProperties(root)
	injectMinProperties(root)
}

func normalizeWildcardPatternProperties(value any) {
	switch node := value.(type) {
	case map[string]any:
		if patternProperties, ok := node["patternProperties"].(map[string]any); ok && len(patternProperties) == 1 {
			if wildcard, exists := patternProperties[""]; exists {
				node["additionalProperties"] = wildcard
				delete(node, "patternProperties")
			}
		}
		for _, child := range node {
			normalizeWildcardPatternProperties(child)
		}
	case []any:
		for _, child := range node {
			normalizeWildcardPatternProperties(child)
		}
	}
}

func normalizeArrayLengthKeywords(value any) {
	switch node := value.(type) {
	case map[string]any:
		if isArraySchema(node) {
			if minLength, ok := node["minLength"]; ok {
				if _, exists := node["minItems"]; !exists {
					node["minItems"] = minLength
				}
				delete(node, "minLength")
			}
			if maxLength, ok := node["maxLength"]; ok {
				if _, exists := node["maxItems"]; !exists {
					node["maxItems"] = maxLength
				}
				delete(node, "maxLength")
			}
		}
		for _, child := range node {
			normalizeArrayLengthKeywords(child)
		}
	case []any:
		for _, child := range node {
			normalizeArrayLengthKeywords(child)
		}
	}
}

func isArraySchema(node map[string]any) bool {
	if typ, ok := node["type"].(string); ok && typ == "array" {
		return true
	}
	if _, ok := node["items"]; ok {
		return true
	}
	if _, ok := node["prefixItems"]; ok {
		return true
	}
	return false
}

func injectMinProperties(value any) {
	switch node := value.(type) {
	case map[string]any:
		if isObjectReferenceSchema(node) || isAtlasGeometrySchema(node) {
			if _, exists := node["minProperties"]; !exists {
				node["minProperties"] = 1
			}
		}
		if isAtlasGeometrySchema(node) {
			injectAtlasGeometryDependencies(node)
		}
		for _, child := range node {
			injectMinProperties(child)
		}
	case []any:
		for _, child := range node {
			injectMinProperties(child)
		}
	}
}

func isObjectReferenceSchema(node map[string]any) bool {
	props, ok := node["properties"].(map[string]any)
	if !ok || len(props) != 2 {
		return false
	}
	return schemaType(node) == "object" && props["entity_id"] != nil && props["task_id"] != nil
}

func isAtlasGeometrySchema(node map[string]any) bool {
	props, ok := node["properties"].(map[string]any)
	if !ok || len(props) != 5 {
		return false
	}
	return schemaType(node) == "object" &&
		props["point_lat"] != nil &&
		props["point_lng"] != nil &&
		props["radius_m"] != nil &&
		props["line"] != nil &&
		props["polygon"] != nil
}

func injectAtlasGeometryDependencies(node map[string]any) {
	if _, exists := node["dependentRequired"]; exists {
		return
	}
	node["dependentRequired"] = map[string]any{
		"point_lat": []any{"point_lng"},
		"point_lng": []any{"point_lat"},
		"radius_m":  []any{"point_lat", "point_lng"},
	}
}

func schemaType(node map[string]any) string {
	typ, _ := node["type"].(string)
	return typ
}

func runCue(root string, args ...string) ([]byte, error) {
	goArgs := append([]string{"run", "cuelang.org/go/cmd/cue@" + cueVersion}, args...)
	cmd := exec.Command("go", goArgs...)
	cmd.Dir = root
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return nil, fmt.Errorf("cue %s failed: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

type goTemplateData struct {
	EntityComponentConstants string
	TaskComponentConstants   string
	EntityComponentKeyArray  string
	TaskComponentKeyArray    string
	MaxGeometryPositions     int
	ComponentsJSONTag        string
	PublishedAtJSONTag       string
	ExtraJSONTag             string
	BucketJSONTag            string
	SizeBytesJSONTag         string
	UsageHintsJSONTag        string
	ReferencedByJSONTag      string
	EntityIDJSONTag          string
	TaskIDJSONTag            string
	LatitudeJSONTag          string
	LongitudeJSONTag         string
	AltitudeMJSONTag         string
	SpeedMSJSONTag           string
	HeadingDegJSONTag        string
	LastUpdateJSONTag        string
	SupportedTasksJSONTag    string
	ObjectIDJSONTag          string
	RoleJSONTag              string
	ClassificationJSONTag    string
	LastSeenJSONTag          string
	BatteryPercentJSONTag    string
	SensorIDJSONTag          string
	TypeJSONTag              string
	HorizontalFOVJSONTag     string
	VerticalFOVJSONTag       string
	HorizontalOrientJSONTag  string
	VerticalOrientJSONTag    string
	LinkStateJSONTag         string
	CurrentTaskIDJSONTag     string
	QueuedTaskIDsJSONTag     string
	ValueJSONTag             string
}

func generatedGo(meta Meta) ([]byte, error) {
	data := goTemplateData{
		EntityComponentConstants: componentConstants("Component", meta.EntityComponentKeys),
		TaskComponentConstants:   componentConstants("TaskComponent", meta.TaskComponentKeys),
		EntityComponentKeyArray:  quotedArray(meta.EntityComponentKeys),
		TaskComponentKeyArray:    quotedArray(meta.TaskComponentKeys),
		MaxGeometryPositions:     meta.MaxGeometryPositions,
		ComponentsJSONTag:        "`json:\"components,omitempty\"`",
		PublishedAtJSONTag:       "`json:\"published_at,omitempty\"`",
		ExtraJSONTag:             "`json:\"-\"`",
		BucketJSONTag:            "`json:\"bucket,omitempty\"`",
		SizeBytesJSONTag:         "`json:\"size_bytes,omitempty\"`",
		UsageHintsJSONTag:        "`json:\"usage_hints,omitempty\"`",
		ReferencedByJSONTag:      "`json:\"referenced_by,omitempty\"`",
		EntityIDJSONTag:          "`json:\"entity_id,omitempty\"`",
		TaskIDJSONTag:            "`json:\"task_id,omitempty\"`",
		LatitudeJSONTag:          "`json:\"latitude,omitempty\"`",
		LongitudeJSONTag:         "`json:\"longitude,omitempty\"`",
		AltitudeMJSONTag:         "`json:\"altitude_m,omitempty\"`",
		SpeedMSJSONTag:           "`json:\"speed_m_s,omitempty\"`",
		HeadingDegJSONTag:        "`json:\"heading_deg,omitempty\"`",
		LastUpdateJSONTag:        "`json:\"last_update,omitempty\"`",
		SupportedTasksJSONTag:    "`json:\"supported_tasks,omitempty\"`",
		ObjectIDJSONTag:          "`json:\"object_id\"`",
		RoleJSONTag:              "`json:\"role\"`",
		ClassificationJSONTag:    "`json:\"classification,omitempty\"`",
		LastSeenJSONTag:          "`json:\"last_seen,omitempty\"`",
		BatteryPercentJSONTag:    "`json:\"battery_percent,omitempty\"`",
		SensorIDJSONTag:          "`json:\"sensor_id\"`",
		TypeJSONTag:              "`json:\"type\"`",
		HorizontalFOVJSONTag:     "`json:\"horizontal_fov,omitempty\"`",
		VerticalFOVJSONTag:       "`json:\"vertical_fov,omitempty\"`",
		HorizontalOrientJSONTag:  "`json:\"horizontal_orientation,omitempty\"`",
		VerticalOrientJSONTag:    "`json:\"vertical_orientation,omitempty\"`",
		LinkStateJSONTag:         "`json:\"link_state,omitempty\"`",
		CurrentTaskIDJSONTag:     "`json:\"current_task_id,omitempty\"`",
		QueuedTaskIDsJSONTag:     "`json:\"queued_task_ids,omitempty\"`",
		ValueJSONTag:             "`json:\"value\"`",
	}

	tmpl, err := template.New("go").Parse(generatedGoTypesTemplate)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, err
	}

	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		return nil, fmt.Errorf("format generated Go: %w", err)
	}
	return formatted, nil
}

func componentConstants(prefix string, keys []string) string {
	var buf strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&buf, "\t%s%s = %q\n", prefix, goIdentifier(key), key)
	}
	return strings.TrimRight(buf.String(), "\n")
}

func quotedArray(values []string) string {
	var buf strings.Builder
	buf.WriteString("[]string{")
	for i, value := range values {
		if i > 0 {
			buf.WriteString(", ")
		}
		fmt.Fprintf(&buf, "%q", value)
	}
	buf.WriteString("}")
	return buf.String()
}

func goIdentifier(value string) string {
	parts := strings.Split(value, "_")
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, "")
}

const generatedGoTypesTemplate = `// Code generated by go run ./tools/generate; DO NOT EDIT.

package atlasprotocol

import (
	"encoding/json"
	"strings"
	"time"
)

const (
{{ .EntityComponentConstants }}

{{ .TaskComponentConstants }}

	MaxGeometryPositions = {{ .MaxGeometryPositions }}
)

var knownEntityComponentKeys = {{ .EntityComponentKeyArray }}
var knownTaskComponentKeys = {{ .TaskComponentKeyArray }}

type EntityBlob struct {
	Components  map[string]any {{ .ComponentsJSONTag }}
	PublishedAt *time.Time     {{ .PublishedAtJSONTag }}
	Extra       map[string]any {{ .ExtraJSONTag }}
}

type TaskBlob struct {
	Components map[string]any {{ .ComponentsJSONTag }}
	Extra      map[string]any {{ .ExtraJSONTag }}
}

type ObjectBlob struct {
	Bucket       *string           {{ .BucketJSONTag }}
	SizeBytes    *float64          {{ .SizeBytesJSONTag }}
	UsageHints   []string          {{ .UsageHintsJSONTag }}
	ReferencedBy []ObjectReference {{ .ReferencedByJSONTag }}
	Extra        map[string]any    {{ .ExtraJSONTag }}
}

type ObjectReference struct {
	EntityID *string {{ .EntityIDJSONTag }}
	TaskID   *string {{ .TaskIDJSONTag }}
}

type TelemetryComponent struct {
	Latitude   *float64   {{ .LatitudeJSONTag }}
	Longitude  *float64   {{ .LongitudeJSONTag }}
	AltitudeM  *float64   {{ .AltitudeMJSONTag }}
	SpeedMS    *float64   {{ .SpeedMSJSONTag }}
	HeadingDeg *float64   {{ .HeadingDegJSONTag }}
	LastUpdate *time.Time {{ .LastUpdateJSONTag }}
}

type GeometryComponent map[string]any

type TaskCatalogComponent struct {
	SupportedTasks []string {{ .SupportedTasksJSONTag }}
}

type MediaRef struct {
	ObjectID string {{ .ObjectIDJSONTag }}
	Role     string {{ .RoleJSONTag }}
}

type MediaRefsComponent []MediaRef

type MilViewComponent struct {
	Classification *string    {{ .ClassificationJSONTag }}
	LastSeen       *time.Time {{ .LastSeenJSONTag }}
}

type HealthComponent struct {
	BatteryPercent *float64 {{ .BatteryPercentJSONTag }}
}

type SensorRef struct {
	SensorID              string   {{ .SensorIDJSONTag }}
	Type                  string   {{ .TypeJSONTag }}
	HorizontalFOV         *float64 {{ .HorizontalFOVJSONTag }}
	VerticalFOV           *float64 {{ .VerticalFOVJSONTag }}
	HorizontalOrientation *float64 {{ .HorizontalOrientJSONTag }}
	VerticalOrientation   *float64 {{ .VerticalOrientJSONTag }}
}

type SensorRefsComponent []SensorRef

type CommunicationsComponent struct {
	LinkState *string {{ .LinkStateJSONTag }}
}

type TaskQueueComponent struct {
	CurrentTaskID *string  {{ .CurrentTaskIDJSONTag }}
	QueuedTaskIDs []string {{ .QueuedTaskIDsJSONTag }}
}

type StatusComponent struct {
	Value      string     {{ .ValueJSONTag }}
	LastUpdate *time.Time {{ .LastUpdateJSONTag }}
}

type HeartbeatComponent struct {
	LastSeen *time.Time {{ .LastSeenJSONTag }}
}

func (b *EntityBlob) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	*b = EntityBlob{}
	for key, value := range raw {
		switch key {
		case "components":
			if err := json.Unmarshal(value, &b.Components); err != nil {
				return err
			}
		case "published_at":
			var stamp string
			if err := json.Unmarshal(value, &stamp); err != nil {
				return err
			}
			parsed, err := time.Parse(time.RFC3339, stamp)
			if err != nil {
				return err
			}
			b.PublishedAt = &parsed
		default:
			if b.Extra == nil {
				b.Extra = make(map[string]any)
			}
			var decoded any
			if err := json.Unmarshal(value, &decoded); err != nil {
				return err
			}
			b.Extra[key] = decoded
		}
	}
	return nil
}

func (b EntityBlob) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(b.Extra)+2)
	for key, value := range b.Extra {
		out[key] = value
	}
	if b.Components != nil {
		out["components"] = b.Components
	}
	if b.PublishedAt != nil {
		out["published_at"] = b.PublishedAt.Format(time.RFC3339)
	}
	return json.Marshal(out)
}

func KnownEntityComponentKeys() []string {
	keys := make([]string, len(knownEntityComponentKeys))
	copy(keys, knownEntityComponentKeys)
	return keys
}

func EntityComponentKeySet() map[string]bool {
	keys := make(map[string]bool, len(knownEntityComponentKeys))
	for _, key := range knownEntityComponentKeys {
		keys[key] = true
	}
	return keys
}

func KnownTaskComponentKeys() []string {
	keys := make([]string, len(knownTaskComponentKeys))
	copy(keys, knownTaskComponentKeys)
	return keys
}

func TaskComponentKeySet() map[string]bool {
	keys := make(map[string]bool, len(knownTaskComponentKeys))
	for _, key := range knownTaskComponentKeys {
		keys[key] = true
	}
	return keys
}

func IsKnownEntityComponent(key string) bool {
	for _, known := range knownEntityComponentKeys {
		if key == known {
			return true
		}
	}
	return false
}

func IsCustomEntityComponent(key string) bool {
	return strings.HasPrefix(key, "custom_")
}

func IsKnownTaskComponent(key string) bool {
	for _, known := range knownTaskComponentKeys {
		if key == known {
			return true
		}
	}
	return false
}

func IsCustomTaskComponent(key string) bool {
	return strings.HasPrefix(key, "custom_")
}
`
