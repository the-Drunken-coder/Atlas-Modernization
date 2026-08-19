package validator

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	protocolschema "github.com/the-drunken-coder/atlas/atlas_protocol/schema"
)

const (
	schemaBundlePath     = "jsonschema/atlas.schema.json"
	schemaBundleLocation = "atlas.schema.json"
	// MaxGeometryPositions is the aggregate position limit for one Polygon.
	MaxGeometryPositions = 10000
)

type compiledSchema struct {
	schemas         map[string]*jsonschema.Schema
	componentFields map[string]map[string]struct{}
}

var compiled struct {
	once   sync.Once
	schema *compiledSchema
	err    error
}

func ValidateEntityBlob(value any) []string {
	return validate("EntityBlob", value)
}

func ValidateObjectBlob(value any) []string {
	return validate("ObjectBlob", value)
}

func ValidateEntityResource(value any) []string {
	return validate("EntityResource", value)
}

func ValidateTaskResource(value any) []string {
	return validate("TaskResource", value)
}

func ValidateObjectResource(value any) []string {
	return validate("ObjectResource", value)
}

func ValidateObjectDetailResource(value any) []string {
	return validate("ObjectDetailResource", value)
}

func ValidateErrorResponse(value any) []string {
	return validate("ErrorResponse", value)
}

func ValidateProtocolRevisionResponse(value any) []string {
	return validate("ProtocolRevisionResponse", value)
}

func ValidateEntityCheckInRequest(value any) []string {
	return validate("EntityCheckInRequest", value)
}

func ValidateEntityCheckInFullResponse(value any) []string {
	return validate("EntityCheckInFullResponse", value)
}

func ValidateEntityCheckInMinimalResponse(value any) []string {
	return validate("EntityCheckInMinimalResponse", value)
}

func ValidateEntityCheckInResponse(value any) []string {
	return validate("EntityCheckInResponse", value)
}

func ValidateFullDatasetResponse(value any) []string {
	return validate("FullDatasetResponse", value)
}

func ValidateChangedSinceResponse(value any) []string {
	return validate("ChangedSinceResponse", value)
}

func ValidateEntityCreateRequest(value any) []string {
	return validate("EntityCreateRequest", value)
}

func ValidateEntityUpdateRequest(value any) []string {
	return validate("EntityUpdateRequest", value)
}

func ValidateTaskCreateRequest(value any) []string {
	return validate("TaskCreateRequest", value)
}

func ValidateTaskAcknowledgeRequest(value any) []string {
	return validate("TaskAcknowledgeRequest", value)
}

func ValidateTaskStartRequest(value any) []string {
	return validate("TaskStartRequest", value)
}

func ValidateTaskProgressRequest(value any) []string {
	return validate("TaskProgressRequest", value)
}

func ValidateTaskCompleteRequest(value any) []string {
	return validate("TaskCompleteRequest", value)
}

func ValidateTaskFailRequest(value any) []string {
	return validate("TaskFailRequest", value)
}

func ValidateTaskCancelRequest(value any) []string {
	return validate("TaskCancelRequest", value)
}

func ValidateRuntimeRegistrationRequest(value any) []string {
	return validate("RuntimeRegistrationRequest", value)
}

func ValidateRuntimeReadyRequest(value any) []string {
	return validate("RuntimeReadyRequest", value)
}

func ValidateRuntimeTaskDeliveryResponse(value any) []string {
	return validate("RuntimeTaskDeliveryResponse", value)
}

func ValidateObjectCreateRequest(value any) []string {
	return validate("ObjectCreateRequest", value)
}

func ValidateObjectUpdateRequest(value any) []string {
	return validate("ObjectUpdateRequest", value)
}

func ValidateFeedEvent(value any) []string {
	return validate("FeedEvent", value)
}

func ValidateFeedAuthMessage(value any) []string {
	return validate("FeedAuthMessage", value)
}

func ValidateFeedSubscribeMessage(value any) []string {
	return validate("FeedSubscribeMessage", value)
}

func ValidateFeedUnsubscribeMessage(value any) []string {
	return validate("FeedUnsubscribeMessage", value)
}

func ValidateFeedClientMessage(value any) []string {
	return validate("FeedClientMessage", value)
}

func ValidateFeedHandshakeMessage(value any) []string {
	return validate("FeedHandshakeMessage", value)
}

func ValidateFeedSubscriptionBarrierMessage(value any) []string {
	return validate("FeedSubscriptionBarrierMessage", value)
}

func ValidateFeedSubscriptionsReadyMessage(value any) []string {
	return validate("FeedSubscriptionsReadyMessage", value)
}

func valueAsSlice(value any) ([]any, bool) {
	if payload, ok := value.([]any); ok {
		return payload, true
	}
	var data []byte
	switch typed := value.(type) {
	case json.RawMessage:
		data = typed
	case []byte:
		data = typed
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		data = encoded
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, false
	}
	payload, ok := decoded.([]any)
	return payload, ok
}

func ValidateEntityComponents(value any) []string {
	return validate("EntityComponents", value)
}

func ValidateCommandCatalog(value any) []string {
	errors := validate("CommandCatalog", value)
	payload, ok := valueAsSlice(value)
	if !ok {
		return errors
	}
	seen := make(map[string]struct{}, len(payload))
	for _, raw := range payload {
		command, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := command["command"].(string)
		if _, duplicate := seen[name]; duplicate && name != "" {
			errors = append(errors, fmt.Sprintf("command %q is duplicated", name))
		}
		seen[name] = struct{}{}
	}
	sort.Strings(errors)
	return errors
}

func ValidateCommandManifest(value any) []string {
	return validate("CommandManifest", value)
}

func ValidateCommandManifestEntry(value any) []string {
	return validate("CommandManifestEntry", value)
}

func ValidateMediaRefsComponent(value any) []string {
	return validate("MediaRefsComponent", value)
}

func ValidateMilViewComponent(value any) []string {
	return validate("MilViewComponent", value)
}

func ValidateHealthComponent(value any) []string {
	return validate("HealthComponent", value)
}

func ValidateSensorRefsComponent(value any) []string {
	return validate("SensorRefsComponent", value)
}

func ValidateCommunicationsComponent(value any) []string {
	return validate("CommunicationsComponent", value)
}

func ValidateStatusComponent(value any) []string {
	return validate("StatusComponent", value)
}

func ValidateHeartbeatComponent(value any) []string {
	return validate("HeartbeatComponent", value)
}

func ValidateTelemetryComponent(value any) []string {
	return validate("TelemetryComponent", value)
}

func ValidateGeometryComponent(value any) []string {
	return validate("GeometryComponent", value)
}

// ValidateDefinition validates a value against one named definition in the
// canonical Protocol bundle. Command input and output schema references use
// this entry point after the catalog has resolved the definition name.
func ValidateDefinition(definition string, value any) []string {
	return validate(definition, value)
}

func validate(definition string, value any) []string {
	normalized, err := normalizeForJSONSchema(value)
	if err != nil {
		return []string{fmt.Sprintf("input cannot be decoded as JSON: %v", err)}
	}
	if path, ok := firstNonFinitePath(normalized, ""); ok {
		if path == "" {
			path = "value"
		}
		return []string{path + ": must be finite"}
	}
	if err := ensureJSONEncodable(normalized); err != nil {
		return []string{fmt.Sprintf("input cannot be encoded as JSON: %v", err)}
	}

	schema, err := getSchema()
	if err != nil {
		return []string{fmt.Sprintf("protocol schema load failed: %v", err)}
	}
	if errors := unknownComponentErrors(schema, definition, normalized); len(errors) > 0 {
		return errors
	}

	compiled, ok := schema.schemas[definition]
	if !ok {
		return []string{fmt.Sprintf("protocol schema definition %s not found", definition)}
	}
	var messages []string
	if err := compiled.Validate(normalized); err != nil {
		messages = append(messages, validationErrorMessages(err)...)
	}
	messages = append(messages, semanticErrors(definition, normalized)...)
	sort.Strings(messages)
	return messages
}

func unknownComponentErrors(schema *compiledSchema, definition string, value any) []string {
	switch definition {
	case "EntityBlob":
		blob, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		return componentUnknowns(blob["components"], schema.componentFields["EntityComponents"])
	case "EntityCreateRequest", "EntityUpdateRequest":
		request, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		return componentUnknowns(request["components"], schema.componentFields["EntityComponents"])
	case "EntityComponents":
		return componentUnknowns(value, schema.componentFields["EntityComponents"])
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
		errors = append(errors, fmt.Sprintf("Unknown component %q", key))
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
	data, err := protocolschema.Files.ReadFile(schemaBundlePath)
	if err != nil {
		return nil, err
	}
	var bundle map[string]any
	if err := json.Unmarshal(data, &bundle); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	if err := compiler.AddResource(schemaBundleLocation, bundle); err != nil {
		return nil, err
	}
	if _, err := compiler.Compile(schemaBundleLocation); err != nil {
		return nil, err
	}

	defs, ok := bundle["$defs"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema bundle has no $defs object")
	}
	definitions := make([]string, 0, len(defs))
	for definition := range defs {
		definitions = append(definitions, definition)
	}
	sort.Strings(definitions)
	schemas := make(map[string]*jsonschema.Schema, len(definitions))
	for _, definition := range definitions {
		schema, err := compiler.Compile(schemaDefinitionLocation(definition))
		if err != nil {
			return nil, fmt.Errorf("compile %s: %w", definition, err)
		}
		schemas[definition] = schema
	}
	componentFields, err := schemaComponentFields(bundle)
	if err != nil {
		return nil, err
	}
	return &compiledSchema{schemas: schemas, componentFields: componentFields}, nil
}

func schemaDefinitionLocation(definition string) string {
	return schemaBundleLocation + "#/$defs/" + definition
}

func schemaComponentFields(bundle map[string]any) (map[string]map[string]struct{}, error) {
	definitions := []string{"EntityComponents"}
	componentFields := make(map[string]map[string]struct{}, len(definitions))
	for _, definition := range definitions {
		fields, err := concreteSchemaProperties(bundle, definition)
		if err != nil {
			return nil, err
		}
		componentFields[definition] = fields
	}
	return componentFields, nil
}

func concreteSchemaProperties(bundle map[string]any, definition string) (map[string]struct{}, error) {
	defs, ok := bundle["$defs"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema bundle has no $defs object")
	}
	raw, ok := defs[definition].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema definition %s not found", definition)
	}
	properties, ok := raw["properties"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema definition %s has no properties", definition)
	}
	fields := make(map[string]struct{}, len(properties))
	for key := range properties {
		fields[key] = struct{}{}
	}
	return fields, nil
}

func validationErrorMessages(err error) []string {
	var validationErr *jsonschema.ValidationError
	if !errors.As(err, &validationErr) {
		return []string{strings.TrimSpace(err.Error())}
	}
	var messages []string
	collectValidationErrorMessages(validationErr, &messages)
	if len(messages) == 0 {
		return []string{strings.TrimSpace(err.Error())}
	}
	sort.Strings(messages)
	return messages
}

func collectValidationErrorMessages(err *jsonschema.ValidationError, messages *[]string) {
	if len(err.Causes) > 0 {
		for _, cause := range err.Causes {
			collectValidationErrorMessages(cause, messages)
		}
		return
	}
	message := strings.TrimSpace(err.Error())
	if unit := err.BasicOutput(); unit != nil && unit.Error != nil {
		message = unit.Error.String()
	}
	path := formatInstanceLocation(err.InstanceLocation)
	if missing, ok := missingPropertyName(message); ok {
		path = joinPath(path, missing)
	}
	if path != "" {
		message = path + ": " + message
	}
	*messages = append(*messages, message)
}

func missingPropertyName(message string) (string, bool) {
	const prefix = "missing property '"
	if !strings.HasPrefix(message, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(message, prefix)
	name, _, ok := strings.Cut(rest, "'")
	return name, ok && name != ""
}

func formatInstanceLocation(parts []string) string {
	if len(parts) == 0 {
		return "value"
	}
	return strings.Join(parts, ".")
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
		message = strings.TrimPrefix(message, "TaskParametersComponent.")
		message = strings.TrimPrefix(message, "TaskParametersComponent")
		prefixed = append(prefixed, fieldPrefix+"."+message)
	}
	return prefixed
}

type jsonReference struct {
	typeOf  reflect.Type
	pointer uintptr
	length  int
}

func normalizeForJSONSchema(value any) (any, error) {
	return normalizeForJSONSchemaValue(value, make(map[jsonReference]struct{}))
}

func normalizeForJSONSchemaValue(value any, active map[jsonReference]struct{}) (any, error) {
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
	default:
		return normalizeReflectedJSONValue(reflect.ValueOf(value), active)
	}
}

func normalizeReflectedJSONValue(value reflect.Value, active map[jsonReference]struct{}) (any, error) {
	if !value.IsValid() {
		return nil, nil
	}

	switch value.Kind() {
	case reflect.Interface:
		if value.IsNil() {
			return nil, nil
		}
		return normalizeForJSONSchemaValue(value.Elem().Interface(), active)
	case reflect.Pointer:
		if value.IsNil() {
			return nil, nil
		}
		release, err := enterJSONReference(value, active)
		if err != nil {
			return nil, err
		}
		defer release()
		return normalizeForJSONSchemaValue(value.Elem().Interface(), active)
	case reflect.Map:
		if value.IsNil() {
			return nil, nil
		}
		if value.Type().Key().Kind() != reflect.String {
			return nil, fmt.Errorf("unsupported map key type %s", value.Type().Key())
		}
		release, err := enterJSONReference(value, active)
		if err != nil {
			return nil, err
		}
		defer release()
		out := make(map[string]any, value.Len())
		for _, key := range value.MapKeys() {
			normalized, err := normalizeForJSONSchemaValue(value.MapIndex(key).Interface(), active)
			if err != nil {
				return nil, err
			}
			out[key.String()] = normalized
		}
		return out, nil
	case reflect.Slice:
		if value.IsNil() {
			return nil, nil
		}
		release, err := enterJSONReference(value, active)
		if err != nil {
			return nil, err
		}
		defer release()
		out := make([]any, value.Len())
		for i := 0; i < value.Len(); i++ {
			normalized, err := normalizeForJSONSchemaValue(value.Index(i).Interface(), active)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	case reflect.Array:
		out := make([]any, value.Len())
		for i := 0; i < value.Len(); i++ {
			normalized, err := normalizeForJSONSchemaValue(value.Index(i).Interface(), active)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	case reflect.Struct:
		return normalizeJSONMarshaler(value.Interface(), active)
	default:
		return value.Interface(), nil
	}
}

func enterJSONReference(value reflect.Value, active map[jsonReference]struct{}) (func(), error) {
	reference := jsonReference{typeOf: value.Type(), pointer: value.Pointer(), length: -1}
	if value.Kind() == reflect.Slice {
		reference.length = value.Len()
	}
	if _, exists := active[reference]; exists {
		return nil, fmt.Errorf("cyclic value of type %s", value.Type())
	}
	active[reference] = struct{}{}
	return func() { delete(active, reference) }, nil
}

func normalizeJSONMarshaler(value any, active map[jsonReference]struct{}) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	return normalizeForJSONSchemaValue(decoded, active)
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
	return normalizeForJSONSchema(value)
}

func ensureJSONEncodable(value any) error {
	_, err := json.Marshal(value)
	return err
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

func semanticErrors(definition string, value any) []string {
	switch definition {
	case "GeometryComponent":
		return geometrySemanticErrors(value, "")
	case "EntityComponents":
		return componentGeometrySemanticErrors(value, "geometry")
	case "EntityBlob", "EntityResource", "EntityCreateRequest", "EntityCheckInRequest", "EntityUpdateRequest":
		return resourceGeometrySemanticErrors(value)
	case "FeedEvent":
		return feedEventGeometrySemanticErrors(value)
	case "EntityCheckInFullResponse", "EntityCheckInMinimalResponse", "EntityCheckInResponse":
		return entityCheckInResponseGeometrySemanticErrors(value)
	case "FullDatasetResponse":
		return fullDatasetResponseGeometrySemanticErrors(value)
	case "ChangedSinceResponse":
		return changedSinceResponseGeometrySemanticErrors(value)
	default:
		return nil
	}
}

func resourceGeometrySemanticErrors(value any) []string {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return componentGeometrySemanticErrors(payload["components"], "components.geometry")
}

func feedEventGeometrySemanticErrors(value any) []string {
	payload, ok := value.(map[string]any)
	if !ok || payload["resource_type"] != "entity" {
		return nil
	}
	resource, ok := payload["resource"].(map[string]any)
	if !ok {
		return nil
	}
	return componentGeometrySemanticErrors(resource["components"], "resource.components.geometry")
}

func entityCheckInResponseGeometrySemanticErrors(value any) []string {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return prefixErrors(resourceGeometrySemanticErrors(payload["entity"]), "entity")
}

func fullDatasetResponseGeometrySemanticErrors(value any) []string {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	entities, ok := payload["entities"].([]any)
	if !ok {
		return nil
	}
	var errors []string
	for index, entity := range entities {
		errors = append(errors, prefixErrors(resourceGeometrySemanticErrors(entity), fmt.Sprintf("entities.%d", index))...)
	}
	return errors
}

func changedSinceResponseGeometrySemanticErrors(value any) []string {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	events, ok := payload["events"].([]any)
	if !ok {
		return nil
	}
	var errors []string
	for index, event := range events {
		errors = append(errors, prefixErrors(feedEventGeometrySemanticErrors(event), fmt.Sprintf("events.%d", index))...)
	}
	return errors
}

func componentGeometrySemanticErrors(value any, path string) []string {
	components, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	geometry, exists := components["geometry"]
	if !exists {
		return nil
	}
	return geometrySemanticErrors(geometry, path)
}

func geometrySemanticErrors(value any, path string) []string {
	geometry, ok := value.(map[string]any)
	if !ok || geometry["type"] != "Polygon" {
		return nil
	}
	rawCoordinates, ok := geometry["coordinates"].([]any)
	if !ok {
		return nil
	}

	var errors []string
	totalPositions := 0
	for i, rawRing := range rawCoordinates {
		ring, ok := rawRing.([]any)
		if !ok {
			continue
		}
		totalPositions += len(ring)
		if len(ring) < 2 {
			continue
		}
		if !positionsEqual(ring[0], ring[len(ring)-1]) {
			errors = append(errors, joinPath(path, fmt.Sprintf("coordinates.%d", i))+": polygon ring must be closed")
		}
	}
	if totalPositions > MaxGeometryPositions {
		errors = append(errors, joinPath(path, "coordinates")+fmt.Sprintf(": polygon positions must not exceed %d", MaxGeometryPositions))
	}
	return errors
}

func positionsEqual(left, right any) bool {
	leftItems, leftOK := left.([]any)
	rightItems, rightOK := right.([]any)
	if !leftOK || !rightOK || len(leftItems) != len(rightItems) {
		return false
	}
	for i := range leftItems {
		if !jsonScalarsEqual(leftItems[i], rightItems[i]) {
			return false
		}
	}
	return true
}

func jsonScalarsEqual(left, right any) bool {
	if leftNumber, ok := numberAsFloat(left); ok {
		rightNumber, rightOK := numberAsFloat(right)
		return rightOK && leftNumber == rightNumber
	}
	return left == right
}

func numberAsFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	default:
		return 0, false
	}
}

func joinPath(prefix, suffix string) string {
	if prefix == "" {
		return suffix
	}
	if suffix == "" {
		return prefix
	}
	return prefix + "." + suffix
}
