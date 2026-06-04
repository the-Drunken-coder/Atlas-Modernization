package artifacts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
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

func patchGeneratedJSONSchema(root map[string]any) {
	normalizeArrayLengthKeywords(root)
	injectMinProperties(root)
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

	tmpl, err := template.New("go").Parse(generatedGoTemplate)
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

const generatedGoTemplate = `// Code generated by go run ./tools/generate; DO NOT EDIT.

package atlasprotocol

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
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

func ValidateEntityBlob(value any) []string {
	blob, ok := objectFromValue(value)
	if !ok {
		return []string{"entity blob must be an object"}
	}

	var errors []string
	if publishedAt, exists := blob["published_at"]; exists {
		errors = append(errors, validateRFC3339Value(publishedAt, "published_at")...)
	}

	if rawComponents, exists := blob["components"]; exists {
		components, ok := objectFromValue(rawComponents)
		if !ok {
			errors = append(errors, "components must be an object")
		} else {
			errors = append(errors, ValidateEntityComponents(components)...)
		}
	}

	return errors
}

func ValidateTaskBlob(value any) []string {
	blob, ok := objectFromValue(value)
	if !ok {
		return []string{"task blob must be an object"}
	}

	if rawComponents, exists := blob["components"]; exists {
		components, ok := objectFromValue(rawComponents)
		if !ok {
			return []string{"components must be an object"}
		}
		return ValidateTaskComponents(components)
	}
	return nil
}

func ValidateObjectBlob(value any) []string {
	blob, ok := objectFromValue(value)
	if !ok {
		return []string{"object blob must be an object"}
	}

	var errors []string
	if bucket, exists := blob["bucket"]; exists {
		if _, ok := bucket.(string); !ok {
			errors = append(errors, "object.bucket: expected string")
		}
	}
	if sizeBytes, exists := blob["size_bytes"]; exists {
		errors = append(errors, validateNonNegativeNumber(sizeBytes, "object.size_bytes")...)
	}
	if usageHints, exists := blob["usage_hints"]; exists {
		errors = append(errors, validateStringArray(usageHints, "object.usage_hints", true)...)
	}
	if referencedBy, exists := blob["referenced_by"]; exists {
		errors = append(errors, validateObjectReferences(referencedBy)...)
	}
	return errors
}

func ValidateEntityComponents(value any) []string {
	components, ok := objectFromValue(value)
	if !ok {
		return []string{"entity components must be an object"}
	}

	var errors []string
	for key := range components {
		if IsKnownEntityComponent(key) || IsCustomEntityComponent(key) {
			continue
		}
		errors = append(errors, fmt.Sprintf("Unknown component '%s'", key))
	}

	if rawTelemetry, exists := components[ComponentTelemetry]; exists {
		if _, ok := objectFromValue(rawTelemetry); ok {
			errors = append(errors, ValidateTelemetryComponent(rawTelemetry)...)
		} else {
			errors = append(errors, "telemetry component must be an object")
		}
	}

	if rawGeometry, exists := components[ComponentGeometry]; exists {
		if _, ok := objectFromValue(rawGeometry); ok {
			errors = append(errors, ValidateGeometryComponent(rawGeometry)...)
		} else {
			errors = append(errors, "geometry component must be an object")
		}
	}
	if rawTaskCatalog, exists := components[ComponentTaskCatalog]; exists {
		if _, ok := objectFromValue(rawTaskCatalog); ok {
			errors = append(errors, ValidateTaskCatalogComponent(rawTaskCatalog)...)
		} else {
			errors = append(errors, "task_catalog component must be an object")
		}
	}
	if rawMediaRefs, exists := components[ComponentMediaRefs]; exists {
		errors = append(errors, ValidateMediaRefsComponent(rawMediaRefs)...)
	}
	if rawMilView, exists := components[ComponentMilView]; exists {
		if _, ok := objectFromValue(rawMilView); ok {
			errors = append(errors, ValidateMilViewComponent(rawMilView)...)
		} else {
			errors = append(errors, "mil_view component must be an object")
		}
	}
	if rawHealth, exists := components[ComponentHealth]; exists {
		if _, ok := objectFromValue(rawHealth); ok {
			errors = append(errors, ValidateHealthComponent(rawHealth)...)
		} else {
			errors = append(errors, "health component must be an object")
		}
	}
	if rawSensorRefs, exists := components[ComponentSensorRefs]; exists {
		errors = append(errors, ValidateSensorRefsComponent(rawSensorRefs)...)
	}
	if rawComms, exists := components[ComponentCommunications]; exists {
		if _, ok := objectFromValue(rawComms); ok {
			errors = append(errors, ValidateCommunicationsComponent(rawComms)...)
		} else {
			errors = append(errors, "communications component must be an object")
		}
	}
	if rawTaskQueue, exists := components[ComponentTaskQueue]; exists {
		if _, ok := objectFromValue(rawTaskQueue); ok {
			errors = append(errors, ValidateTaskQueueComponent(rawTaskQueue)...)
		} else {
			errors = append(errors, "task_queue component must be an object")
		}
	}
	if rawStatus, exists := components[ComponentStatus]; exists {
		if _, ok := objectFromValue(rawStatus); ok {
			errors = append(errors, ValidateStatusComponent(rawStatus)...)
		} else {
			errors = append(errors, "status component must be an object")
		}
	}
	if rawHeartbeat, exists := components[ComponentHeartbeat]; exists {
		if _, ok := objectFromValue(rawHeartbeat); ok {
			errors = append(errors, ValidateHeartbeatComponent(rawHeartbeat)...)
		} else {
			errors = append(errors, "heartbeat component must be an object")
		}
	}

	return errors
}

func ValidateTaskComponents(value any) []string {
	components, ok := objectFromValue(value)
	if !ok {
		return []string{"task components must be an object"}
	}

	var errors []string
	for key := range components {
		if IsKnownTaskComponent(key) || IsCustomTaskComponent(key) {
			continue
		}
		errors = append(errors, fmt.Sprintf("Unknown component '%s'", key))
	}

	if rawCommand, exists := components[TaskComponentCommand]; exists {
		if _, ok := objectFromValue(rawCommand); ok {
			errors = append(errors, ValidateCommandComponent(rawCommand)...)
		} else {
			errors = append(errors, "command component must be an object")
		}
	}
	if rawParameters, exists := components[TaskComponentParameters]; exists {
		if _, ok := objectFromValue(rawParameters); ok {
			errors = append(errors, ValidateTaskParametersComponent(rawParameters, "parameters.")...)
		} else {
			errors = append(errors, "parameters component must be an object")
		}
	}
	if rawProgress, exists := components[TaskComponentProgress]; exists {
		if _, ok := objectFromValue(rawProgress); ok {
			errors = append(errors, ValidateTaskProgressComponent(rawProgress)...)
		} else {
			errors = append(errors, "progress component must be an object")
		}
	}
	if rawTarget, exists := components[TaskComponentTarget]; exists {
		if _, ok := objectFromValue(rawTarget); ok {
			errors = append(errors, ValidateTaskParametersComponent(rawTarget, "target.")...)
		} else {
			errors = append(errors, "target component must be an object")
		}
	}
	if rawMessage, exists := components[TaskComponentStatusMessage]; exists {
		if _, ok := rawMessage.(string); !ok {
			errors = append(errors, "status_message must be a string")
		}
	}

	return errors
}

func ValidateCommandComponent(value any) []string {
	command, ok := objectFromValue(value)
	if !ok {
		return []string{"command component must be an object"}
	}

	var errors []string
	for key := range command {
		switch key {
		case "type", "id", "target", "parameters":
		default:
			errors = append(errors, fmt.Sprintf("command: unknown field '%s'", key))
		}
	}

	cmdType, exists := command["type"]
	if !exists {
		errors = append(errors, "command: missing required field 'type'")
		return errors
	}
	str, ok := cmdType.(string)
	if !ok {
		errors = append(errors, "command.type: expected string")
	} else if strings.TrimSpace(str) == "" {
		errors = append(errors, "command.type: must be non-empty")
	}

	if id, exists := command["id"]; exists {
		str, ok := id.(string)
		if !ok {
			errors = append(errors, "command.id: expected string")
		} else if strings.TrimSpace(str) == "" {
			errors = append(errors, "command.id: must be non-empty")
		}
	}
	return errors
}

func ValidateTaskParametersComponent(value any, fieldPrefix string) []string {
	params, ok := objectFromValue(value)
	if !ok {
		return []string{strings.TrimSuffix(fieldPrefix, ".") + " component must be an object"}
	}

	var errors []string
	if lat, exists := params["latitude"]; exists {
		errors = append(errors, validateNumberRange(lat, fieldPrefix+"latitude", -90, 90, true, true)...)
	}
	if lng, exists := params["longitude"]; exists {
		errors = append(errors, validateNumberRange(lng, fieldPrefix+"longitude", -180, 180, true, true)...)
	}
	return errors
}

func ValidateTaskProgressComponent(value any) []string {
	progress, ok := objectFromValue(value)
	if !ok {
		return []string{"progress component must be an object"}
	}

	var errors []string
	if percent, exists := progress["percent"]; exists {
		errors = append(errors, validateNumberRange(percent, "progress.percent", 0, 100, true, true)...)
	}
	if updatedAt, exists := progress["updated_at"]; exists {
		errors = append(errors, validateRFC3339Value(updatedAt, "progress.updated_at")...)
	}
	return errors
}

func ValidateTaskCatalogComponent(value any) []string {
	catalog, ok := objectFromValue(value)
	if !ok {
		return []string{"task_catalog component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(catalog, "task_catalog", "supported_tasks")...)
	if supported, exists := catalog["supported_tasks"]; exists {
		errors = append(errors, validateStringArray(supported, "task_catalog.supported_tasks", true)...)
	}
	return errors
}

func ValidateMediaRefsComponent(value any) []string {
	refs, ok := arrayFromValue(value)
	if !ok {
		return []string{"media_refs: expected array"}
	}

	var errors []string
	for i, ref := range refs {
		refMap, ok := objectFromValue(ref)
		if !ok {
			errors = append(errors, fmt.Sprintf("media_refs[%d]: expected object", i))
			continue
		}
		errors = append(errors, validateKnownFields(refMap, fmt.Sprintf("media_refs[%d]", i), "object_id", "role")...)

		objectID, hasObjectID := refMap["object_id"]
		if !hasObjectID {
			errors = append(errors, fmt.Sprintf("media_refs[%d]: missing required field 'object_id'", i))
		} else {
			errors = append(errors, validateNonEmptyString(objectID, fmt.Sprintf("media_refs[%d].object_id", i))...)
		}

		role, hasRole := refMap["role"]
		if !hasRole {
			errors = append(errors, fmt.Sprintf("media_refs[%d]: missing required field 'role'", i))
			continue
		}
		roleString, ok := role.(string)
		if !ok {
			errors = append(errors, fmt.Sprintf("media_refs[%d].role: expected string", i))
			continue
		}
		roleTrim := strings.TrimSpace(roleString)
		if roleTrim == "" {
			errors = append(errors, fmt.Sprintf("media_refs[%d].role: must be non-empty", i))
		} else if roleTrim != roleString {
			errors = append(errors, fmt.Sprintf("media_refs[%d].role: must not include leading or trailing whitespace", i))
		} else if !isAllowedString(roleTrim, "camera_feed", "thumbnail", "heatmap_data") {
			errors = append(errors, fmt.Sprintf("media_refs[%d].role: must be one of camera_feed, thumbnail, heatmap_data", i))
		}
	}
	return errors
}

func ValidateMilViewComponent(value any) []string {
	milView, ok := objectFromValue(value)
	if !ok {
		return []string{"mil_view component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(milView, "mil_view", "classification", "last_seen")...)
	if classification, exists := milView["classification"]; exists {
		str, ok := classification.(string)
		if !ok {
			errors = append(errors, "mil_view.classification: expected string")
		} else if !isAllowedString(str, "friendly", "hostile", "neutral", "unknown", "civilian") {
			errors = append(errors, "mil_view.classification: must be one of friendly, hostile, neutral, unknown, civilian")
		}
	}
	if lastSeen, exists := milView["last_seen"]; exists {
		str, ok := lastSeen.(string)
		if !ok {
			errors = append(errors, "mil_view.last_seen: expected string (RFC3339 timestamp)")
		} else if _, err := time.Parse(time.RFC3339, str); err != nil {
			errors = append(errors, fmt.Sprintf("mil_view.last_seen: invalid RFC3339 timestamp: %s", err))
		}
	}
	return errors
}

func ValidateHealthComponent(value any) []string {
	health, ok := objectFromValue(value)
	if !ok {
		return []string{"health component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(health, "health", "battery_percent")...)
	if battery, exists := health["battery_percent"]; exists {
		errors = append(errors, validateNumberRange(battery, "health.battery_percent", 0, 100, true, true)...)
	}
	return errors
}

func ValidateSensorRefsComponent(value any) []string {
	refs, ok := arrayFromValue(value)
	if !ok {
		return []string{"sensor_refs: expected array"}
	}

	var errors []string
	for i, ref := range refs {
		refMap, ok := objectFromValue(ref)
		if !ok {
			errors = append(errors, fmt.Sprintf("sensor_refs[%d]: expected object", i))
			continue
		}
		prefix := fmt.Sprintf("sensor_refs[%d]", i)
		errors = append(errors, validateKnownFields(
			refMap,
			prefix,
			"sensor_id",
			"type",
			"horizontal_fov",
			"vertical_fov",
			"horizontal_orientation",
			"vertical_orientation",
		)...)

		sensorID, hasSensorID := refMap["sensor_id"]
		if !hasSensorID {
			errors = append(errors, fmt.Sprintf("%s: missing required field 'sensor_id'", prefix))
		} else {
			errors = append(errors, validateNonEmptyString(sensorID, prefix+".sensor_id")...)
		}

		sensorType, hasSensorType := refMap["type"]
		if !hasSensorType {
			errors = append(errors, fmt.Sprintf("%s: missing required field 'type'", prefix))
		} else {
			errors = append(errors, validateNonEmptyString(sensorType, prefix+".type")...)
		}

		for _, field := range []string{"horizontal_fov", "vertical_fov", "horizontal_orientation", "vertical_orientation"} {
			if val, exists := refMap[field]; exists {
				errors = append(errors, validateFiniteNumber(val, prefix+"."+field)...)
			}
		}
	}
	return errors
}

func ValidateCommunicationsComponent(value any) []string {
	comms, ok := objectFromValue(value)
	if !ok {
		return []string{"communications component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(comms, "communications", "link_state")...)
	if linkState, exists := comms["link_state"]; exists {
		str, ok := linkState.(string)
		if !ok {
			errors = append(errors, "communications.link_state: expected string")
		} else if !isAllowedString(str, "connected", "disconnected", "degraded", "unknown") {
			errors = append(errors, "communications.link_state: must be one of connected, disconnected, degraded, unknown")
		}
	}
	return errors
}

func ValidateTaskQueueComponent(value any) []string {
	queue, ok := objectFromValue(value)
	if !ok {
		return []string{"task_queue component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(queue, "task_queue", "current_task_id", "queued_task_ids")...)
	if currentTask, exists := queue["current_task_id"]; exists && currentTask != nil {
		s, ok := currentTask.(string)
		if !ok {
			errors = append(errors, "task_queue.current_task_id: expected string or null")
		} else if strings.TrimSpace(s) == "" {
			errors = append(errors, "task_queue.current_task_id: must be non-empty when provided")
		}
	}
	if queued, exists := queue["queued_task_ids"]; exists {
		errors = append(errors, validateStringArray(queued, "task_queue.queued_task_ids", true)...)
	}
	return errors
}

func ValidateStatusComponent(value any) []string {
	status, ok := objectFromValue(value)
	if !ok {
		return []string{"status component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(status, "status", "value", "last_update")...)
	valueField, ok := status["value"].(string)
	if !ok || strings.TrimSpace(valueField) == "" {
		errors = append(errors, "status.value is required and must be a non-empty string")
	}
	if lastUpdate, exists := status["last_update"]; exists {
		lastUpdateStr, ok := lastUpdate.(string)
		if !ok {
			errors = append(errors, "status.last_update must be a string")
		} else if _, err := time.Parse(time.RFC3339, lastUpdateStr); err != nil {
			errors = append(errors, "status.last_update must be a valid RFC3339 timestamp")
		}
	}
	return errors
}

func ValidateHeartbeatComponent(value any) []string {
	heartbeat, ok := objectFromValue(value)
	if !ok {
		return []string{"heartbeat component must be an object"}
	}

	var errors []string
	errors = append(errors, validateKnownFields(heartbeat, "heartbeat", "last_seen")...)
	lastSeen, ok := heartbeat["last_seen"].(string)
	if !ok || strings.TrimSpace(lastSeen) == "" {
		errors = append(errors, "heartbeat.last_seen is required and must be a non-empty string")
		return errors
	}
	if _, err := time.Parse(time.RFC3339, lastSeen); err != nil {
		errors = append(errors, "heartbeat.last_seen must be a valid RFC3339 timestamp")
	}
	return errors
}

func ValidateTelemetryComponent(value any) []string {
	telemetry, ok := objectFromValue(value)
	if !ok {
		return []string{"telemetry component must be an object"}
	}

	var errors []string
	for key := range telemetry {
		if !isKnownTelemetryField(key) {
			errors = append(errors, fmt.Sprintf("telemetry: unknown field '%s'", key))
		}
	}

	if value, exists := telemetry["latitude"]; exists {
		errors = append(errors, validateNumberRange(value, "telemetry.latitude", -90, 90, true, true)...)
	}
	if value, exists := telemetry["longitude"]; exists {
		errors = append(errors, validateNumberRange(value, "telemetry.longitude", -180, 180, true, true)...)
	}
	if value, exists := telemetry["altitude_m"]; exists {
		errors = append(errors, validateFiniteNumber(value, "telemetry.altitude_m")...)
	}
	if value, exists := telemetry["speed_m_s"]; exists {
		errors = append(errors, validateNonNegativeNumber(value, "telemetry.speed_m_s")...)
	}
	if value, exists := telemetry["heading_deg"]; exists {
		errors = append(errors, validateNumberRange(value, "telemetry.heading_deg", 0, 360, true, false)...)
	}
	if value, exists := telemetry["last_update"]; exists {
		errors = append(errors, validateRFC3339Value(value, "telemetry.last_update")...)
	}

	return errors
}

func isKnownTelemetryField(key string) bool {
	switch key {
	case "latitude", "longitude", "altitude_m", "speed_m_s", "heading_deg", "last_update":
		return true
	default:
		return false
	}
}

func ValidateGeometryComponent(value any) []string {
	geometry, ok := objectFromValue(value)
	if !ok {
		return []string{"geometry component must be an object"}
	}
	if len(geometry) == 0 {
		return []string{"geometry: component cannot be empty"}
	}

	typeValue, hasTypeKey := geometry["type"]
	coordinates, hasCoordinates := geometry["coordinates"]
	geoJSONType, hasStringType := typeValue.(string)

	if hasStringType && hasCoordinates {
		return validateGeoJSONFormat(geometry, geoJSONType, coordinates)
	}
	if hasTypeKey || hasCoordinates {
		var errors []string
		if !hasTypeKey {
			errors = append(errors, "geometry: GeoJSON format requires 'type' field")
		} else if !hasStringType {
			errors = append(errors, "geometry.type must be a string")
		}
		if !hasCoordinates {
			errors = append(errors, "geometry: GeoJSON format requires 'coordinates' field")
		}
		return errors
	}

	if hasAtlasGeometryField(geometry) {
		return validateAtlasFormat(geometry)
	}

	return []string{"geometry: unrecognized format - must contain either (type + coordinates) or (point_lat + point_lng / polygon / line / radius_m)"}
}

func validateGeoJSONFormat(geometry map[string]any, geoType string, coordinates any) []string {
	if geoType != "Point" && geoType != "LineString" && geoType != "Polygon" {
		return []string{"geometry.type must be one of: Point, LineString, Polygon"}
	}

	var errors []string
	for key := range geometry {
		if key != "type" && key != "coordinates" {
			errors = append(errors, fmt.Sprintf("geometry: unknown GeoJSON field '%s'", key))
		}
	}

	coordsArray, ok := coordinates.([]any)
	if !ok {
		return append(errors, "geometry.coordinates must be an array")
	}

	switch geoType {
	case "Point":
		errors = append(errors, validateGeoJSONPoint(coordsArray)...)
	case "LineString":
		if len(coordsArray) > MaxGeometryPositions {
			return append(errors, fmt.Sprintf("geometry.coordinates: exceeds maximum of %d points", MaxGeometryPositions))
		}
		errors = append(errors, validateGeoJSONLineString(coordsArray)...)
	case "Polygon":
		errors = append(errors, validateGeoJSONPolygon(coordsArray)...)
	}

	return errors
}

func validateGeoJSONPoint(coords []any) []string {
	if len(coords) < 2 {
		return []string{"geometry.coordinates: Point requires at least [longitude, latitude]"}
	}
	return validateGeoJSONPosition(coords, "geometry.coordinates")
}

func validateGeoJSONLineString(coords []any) []string {
	if len(coords) < 2 {
		return []string{"geometry.coordinates: LineString requires at least 2 positions"}
	}

	var errors []string
	for i, pos := range coords {
		posArray, ok := pos.([]any)
		if !ok {
			errors = append(errors, fmt.Sprintf("geometry.coordinates[%d]: expected [longitude, latitude] array", i))
			continue
		}
		errors = append(errors, validateGeoJSONPosition(posArray, fmt.Sprintf("geometry.coordinates[%d]", i))...)
	}
	return errors
}

func validateGeoJSONPolygon(coords []any) []string {
	if len(coords) == 0 {
		return []string{"geometry.coordinates: Polygon requires at least one ring"}
	}

	totalPositions := 0
	for _, ring := range coords {
		if ringArray, ok := ring.([]any); ok {
			totalPositions += len(ringArray)
		}
	}
	if totalPositions > MaxGeometryPositions {
		return []string{fmt.Sprintf("geometry.coordinates: exceeds maximum of %d total positions across all rings", MaxGeometryPositions)}
	}

	var errors []string
	for ringIdx, ring := range coords {
		ringArray, ok := ring.([]any)
		if !ok {
			errors = append(errors, fmt.Sprintf("geometry.coordinates[%d]: expected ring array", ringIdx))
			continue
		}
		if len(ringArray) < 4 {
			errors = append(errors, fmt.Sprintf("geometry.coordinates[%d]: Polygon ring requires at least 4 positions", ringIdx))
			continue
		}
		for posIdx, pos := range ringArray {
			posArray, ok := pos.([]any)
			if !ok {
				errors = append(errors, fmt.Sprintf("geometry.coordinates[%d][%d]: expected [longitude, latitude] array", ringIdx, posIdx))
				continue
			}
			errors = append(errors, validateGeoJSONPosition(posArray, fmt.Sprintf("geometry.coordinates[%d][%d]", ringIdx, posIdx))...)
		}
		first, firstOK := ringArray[0].([]any)
		last, lastOK := ringArray[len(ringArray)-1].([]any)
		if firstOK && lastOK && !positionsEqual(first, last) {
			errors = append(errors, fmt.Sprintf("geometry.coordinates[%d]: Polygon ring must be closed (first position must equal last)", ringIdx))
		}
	}
	return errors
}

func validateGeoJSONPosition(pos []any, path string) []string {
	if len(pos) < 2 {
		return []string{fmt.Sprintf("%s: expected [longitude, latitude] array with at least 2 elements", path)}
	}

	var errors []string
	for i, coord := range pos {
		num, ok := numberFromValue(coord)
		if !ok {
			errors = append(errors, fmt.Sprintf("%s[%d]: expected number, got %T", path, i, coord))
			continue
		}
		if math.IsNaN(num) || math.IsInf(num, 0) {
			errors = append(errors, fmt.Sprintf("%s[%d]: must be finite (not NaN or Inf)", path, i))
			continue
		}

		switch i {
		case 0:
			if num < -180 || num > 180 {
				errors = append(errors, fmt.Sprintf("%s[0]: longitude %.6f is out of range [-180, 180]", path, num))
			}
		case 1:
			if num < -90 || num > 90 {
				errors = append(errors, fmt.Sprintf("%s[1]: latitude %.6f is out of range [-90, 90]", path, num))
			}
		}
	}
	return errors
}

func positionsEqual(a, b []any) bool {
	if len(a) != len(b) || len(a) < 2 {
		return false
	}
	for i := range a {
		aNum, okA := numberFromValue(a[i])
		bNum, okB := numberFromValue(b[i])
		if !okA || !okB || aNum != bNum {
			return false
		}
	}
	return true
}

func validateAtlasFormat(geometry map[string]any) []string {
	var errors []string
	for key := range geometry {
		if !isAtlasGeometryField(key) {
			errors = append(errors, fmt.Sprintf("geometry: unknown Atlas geometry field '%s'", key))
		}
	}

	_, hasPointLat := geometry["point_lat"]
	_, hasPointLng := geometry["point_lng"]
	_, hasRadius := geometry["radius_m"]

	if hasPointLat != hasPointLng {
		errors = append(errors, "geometry: point_lat and point_lng must be provided together")
	}
	if hasRadius && (!hasPointLat || !hasPointLng) {
		errors = append(errors, "geometry: radius_m requires both point_lat and point_lng")
	}

	if value, exists := geometry["point_lat"]; exists {
		errors = append(errors, validateNamedCoordinate(value, "geometry.point_lat", "latitude", -90, 90)...)
	}
	if value, exists := geometry["point_lng"]; exists {
		errors = append(errors, validateNamedCoordinate(value, "geometry.point_lng", "longitude", -180, 180)...)
	}
	if value, exists := geometry["radius_m"]; exists {
		errors = append(errors, validatePositiveNumber(value, "geometry.radius_m")...)
	}
	if value, exists := geometry["polygon"]; exists {
		errors = append(errors, validateAtlasPolygon(value)...)
	}
	if value, exists := geometry["line"]; exists {
		errors = append(errors, validateAtlasLine(value)...)
	}

	return errors
}

func hasAtlasGeometryField(geometry map[string]any) bool {
	for key := range geometry {
		if isAtlasGeometryField(key) {
			return true
		}
	}
	return false
}

func isAtlasGeometryField(key string) bool {
	switch key {
	case "point_lat", "point_lng", "radius_m", "polygon", "line":
		return true
	default:
		return false
	}
}

func validateAtlasPolygon(value any) []string {
	polygonArray, ok := value.([]any)
	if !ok {
		return []string{"geometry.polygon: expected array of [lat, lng] pairs"}
	}

	var errors []string
	if len(polygonArray) < 3 {
		errors = append(errors, fmt.Sprintf("geometry.polygon: requires at least 3 points, got %d", len(polygonArray)))
	}
	if len(polygonArray) > MaxGeometryPositions {
		errors = append(errors, fmt.Sprintf("geometry.polygon: exceeds maximum of %d points", MaxGeometryPositions))
	}
	for i, point := range polygonArray {
		pointArray, ok := point.([]any)
		if !ok {
			errors = append(errors, fmt.Sprintf("geometry.polygon[%d]: expected [lat, lng] array", i))
			continue
		}
		errors = append(errors, validateAtlasPoint(pointArray, fmt.Sprintf("geometry.polygon[%d]", i))...)
	}
	return errors
}

func validateAtlasLine(value any) []string {
	lineArray, ok := value.([]any)
	if !ok {
		return []string{"geometry.line: expected array of [lat, lng] pairs"}
	}

	var errors []string
	if len(lineArray) < 2 {
		errors = append(errors, fmt.Sprintf("geometry.line: requires at least 2 points, got %d", len(lineArray)))
	}
	if len(lineArray) > MaxGeometryPositions {
		errors = append(errors, fmt.Sprintf("geometry.line: exceeds maximum of %d points", MaxGeometryPositions))
	}
	for i, point := range lineArray {
		pointArray, ok := point.([]any)
		if !ok {
			errors = append(errors, fmt.Sprintf("geometry.line[%d]: expected [lat, lng] array", i))
			continue
		}
		errors = append(errors, validateAtlasPoint(pointArray, fmt.Sprintf("geometry.line[%d]", i))...)
	}
	return errors
}

func validateAtlasPoint(point []any, path string) []string {
	if len(point) != 2 {
		return []string{fmt.Sprintf("%s: expected [lat, lng] array with exactly 2 elements", path)}
	}

	var errors []string
	errors = append(errors, validateNumberRange(point[0], path+"[0]", -90, 90, true, true, "latitude")...)
	errors = append(errors, validateNumberRange(point[1], path+"[1]", -180, 180, true, true, "longitude")...)
	return errors
}

func validateKnownFields(values map[string]any, path string, allowed ...string) []string {
	allowedSet := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = true
	}

	var errors []string
	for key := range values {
		if !allowedSet[key] {
			errors = append(errors, fmt.Sprintf("%s: unknown field '%s'", path, key))
		}
	}
	return errors
}

func isAllowedString(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func validateFiniteNumber(value any, path string) []string {
	num, ok := numberFromValue(value)
	if !ok {
		return []string{path + ": expected number"}
	}
	if math.IsNaN(num) || math.IsInf(num, 0) {
		return []string{path + ": must be finite (not NaN or Inf)"}
	}
	return nil
}

func validateNonNegativeNumber(value any, path string) []string {
	if errors := validateFiniteNumber(value, path); len(errors) > 0 {
		return errors
	}
	num, _ := numberFromValue(value)
	if num < 0 {
		return []string{fmt.Sprintf("%s: %.6f must be non-negative", path, num)}
	}
	return nil
}

func validatePositiveNumber(value any, path string) []string {
	if errors := validateFiniteNumber(value, path); len(errors) > 0 {
		return errors
	}
	num, _ := numberFromValue(value)
	if num <= 0 {
		return []string{fmt.Sprintf("%s: must be positive, got %.6f", path, num)}
	}
	return nil
}

func validateStringArray(value any, path string, nonEmpty bool) []string {
	items, ok := arrayFromValue(value)
	if !ok {
		return []string{path + ": expected array of strings"}
	}

	var errors []string
	for i, item := range items {
		str, ok := item.(string)
		if !ok {
			errors = append(errors, fmt.Sprintf("%s[%d]: expected string", path, i))
			continue
		}
		if nonEmpty && strings.TrimSpace(str) == "" {
			errors = append(errors, fmt.Sprintf("%s[%d]: must be non-empty", path, i))
		}
	}
	return errors
}

func validateObjectReferences(value any) []string {
	refs, ok := arrayFromValue(value)
	if !ok {
		return []string{"object.referenced_by: expected array of reference objects"}
	}

	var errors []string
	for i, ref := range refs {
		refMap, ok := objectFromValue(ref)
		if !ok {
			errors = append(errors, fmt.Sprintf("object.referenced_by[%d]: expected object", i))
			continue
		}
		for key := range refMap {
			if key != "entity_id" && key != "task_id" {
				errors = append(errors, fmt.Sprintf("object.referenced_by[%d]: unknown field '%s'", i, key))
			}
		}

		entityID, hasEntityID := refMap["entity_id"]
		taskID, hasTaskID := refMap["task_id"]
		if !hasEntityID && !hasTaskID {
			errors = append(errors, fmt.Sprintf("object.referenced_by[%d]: must include entity_id or task_id", i))
			continue
		}
		if hasEntityID {
			errors = append(errors, validateNonEmptyString(entityID, fmt.Sprintf("object.referenced_by[%d].entity_id", i))...)
		}
		if hasTaskID {
			errors = append(errors, validateNonEmptyString(taskID, fmt.Sprintf("object.referenced_by[%d].task_id", i))...)
		}
	}
	return errors
}

func validateNonEmptyString(value any, path string) []string {
	str, ok := value.(string)
	if !ok {
		return []string{path + ": expected string"}
	}
	if strings.TrimSpace(str) == "" {
		return []string{path + ": must be non-empty"}
	}
	return nil
}

func validateNamedCoordinate(value any, path, name string, min, max float64) []string {
	if errors := validateFiniteNumber(value, path); len(errors) > 0 {
		return errors
	}
	num, _ := numberFromValue(value)
	if num < min || num > max {
		return []string{fmt.Sprintf("%s: %s %.6f is out of range [%.0f, %.0f]", path, name, num, min, max)}
	}
	return nil
}

func validateNumberRange(value any, path string, min, max float64, includeMin, includeMax bool, names ...string) []string {
	if errors := validateFiniteNumber(value, path); len(errors) > 0 {
		if len(names) > 0 && strings.Contains(errors[0], ": expected number") {
			return []string{fmt.Sprintf("%s: expected number for %s", path, names[0])}
		}
		if len(names) > 0 && strings.Contains(errors[0], ": must be finite") {
			return []string{fmt.Sprintf("%s: %s must be finite (not NaN or Inf)", path, names[0])}
		}
		return errors
	}
	num, _ := numberFromValue(value)

	tooLow := num < min || (!includeMin && num == min)
	tooHigh := num > max || (!includeMax && num == max)
	if !tooLow && !tooHigh {
		return nil
	}

	if len(names) > 0 {
		return []string{fmt.Sprintf("%s: %s %.6f is out of range [%.0f, %.0f]", path, names[0], num, min, max)}
	}
	if includeMax {
		return []string{fmt.Sprintf("%s: %.6f is out of range [%.0f, %.0f]", path, num, min, max)}
	}
	return []string{fmt.Sprintf("%s: %.6f is out of range [%.0f, %.0f)", path, num, min, max)}
}

func validateRFC3339Value(value any, path string) []string {
	str, ok := value.(string)
	if !ok {
		return []string{path + ": expected string (RFC3339 timestamp)"}
	}
	if _, err := time.Parse(time.RFC3339, str); err != nil {
		return []string{fmt.Sprintf("%s: invalid RFC3339 timestamp: %s", path, err)}
	}
	return nil
}

func objectFromValue(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if typed == nil {
			return nil, false
		}
		return typed, true
	case GeometryComponent:
		if typed == nil {
			return nil, false
		}
		return map[string]any(typed), true
	case EntityBlob:
		return entityBlobToMap(typed), true
	case *EntityBlob:
		if typed == nil {
			return nil, false
		}
		return entityBlobToMap(*typed), true
	case TaskBlob:
		return taskBlobToMap(typed), true
	case *TaskBlob:
		if typed == nil {
			return nil, false
		}
		return taskBlobToMap(*typed), true
	case ObjectBlob:
		return objectBlobToMap(typed), true
	case *ObjectBlob:
		if typed == nil {
			return nil, false
		}
		return objectBlobToMap(*typed), true
	case json.RawMessage:
		return objectFromJSON(typed)
	case []byte:
		return objectFromJSON(typed)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		return objectFromJSON(encoded)
	}
}

func arrayFromValue(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		if typed == nil {
			return nil, false
		}
		return typed, true
	case json.RawMessage:
		return arrayFromJSON(typed)
	case []byte:
		return arrayFromJSON(typed)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		return arrayFromJSON(encoded)
	}
}

func entityBlobToMap(blob EntityBlob) map[string]any {
	out := make(map[string]any, len(blob.Extra)+2)
	for key, value := range blob.Extra {
		out[key] = value
	}
	if blob.Components != nil {
		out["components"] = blob.Components
	}
	if blob.PublishedAt != nil {
		out["published_at"] = blob.PublishedAt.Format(time.RFC3339)
	}
	return out
}

func taskBlobToMap(blob TaskBlob) map[string]any {
	out := make(map[string]any, len(blob.Extra)+1)
	for key, value := range blob.Extra {
		out[key] = value
	}
	if blob.Components != nil {
		out["components"] = blob.Components
	}
	return out
}

func objectBlobToMap(blob ObjectBlob) map[string]any {
	out := make(map[string]any, len(blob.Extra)+4)
	for key, value := range blob.Extra {
		out[key] = value
	}
	if blob.Bucket != nil {
		out["bucket"] = *blob.Bucket
	}
	if blob.SizeBytes != nil {
		out["size_bytes"] = *blob.SizeBytes
	}
	if blob.UsageHints != nil {
		items := make([]any, len(blob.UsageHints))
		for i, item := range blob.UsageHints {
			items[i] = item
		}
		out["usage_hints"] = items
	}
	if blob.ReferencedBy != nil {
		items := make([]any, len(blob.ReferencedBy))
		for i, item := range blob.ReferencedBy {
			ref := make(map[string]any)
			if item.EntityID != nil {
				ref["entity_id"] = *item.EntityID
			}
			if item.TaskID != nil {
				ref["task_id"] = *item.TaskID
			}
			items[i] = ref
		}
		out["referenced_by"] = items
	}
	return out
}

func objectFromJSON(data []byte) (map[string]any, bool) {
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, false
	}
	return decoded, decoded != nil
}

func arrayFromJSON(data []byte) ([]any, bool) {
	var decoded []any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, false
	}
	return decoded, decoded != nil
}

func numberFromValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int8:
		return float64(typed), true
	case int16:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint8:
		return float64(typed), true
	case uint16:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}
`
