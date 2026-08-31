package artifacts

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

var runtimeValidatorTypeNames = []string{
	"CommandCatalog",
	"CommandManifest",
	"PluginManifest",
	"PluginStatus",
	"PluginDiscoveryResponse",
	"MapArea",
	"SpatialGeometry",
	"SpatialOperationResult",
	"ProtocolRevisionResponse",
	"EntityCheckInRequest",
	"EntityCheckInFullResponse",
	"EntityCheckInMinimalResponse",
	"EntityCheckInResponse",
	"FullDatasetResponse",
	"ChangedSinceResponse",
	"EntityCreateRequest",
	"EntityUpdateRequest",
	"ObjectCreateRequest",
	"ObjectDetailResource",
	"ObjectUpdateRequest",
	"TaskCreateRequest",
	"TaskAcknowledgeRequest",
	"TaskStartRequest",
	"TaskProgressRequest",
	"TaskCompleteRequest",
	"TaskFailRequest",
	"TaskCancelRequest",
	"RuntimeRegistrationRequest",
	"RuntimeStopRequest",
	"RuntimeReadyRequest",
	"RuntimeTaskDeliveryResponse",
	"EntityResource",
	"TaskResource",
	"ObjectResource",
	"FeedEvent",
	"FeedHandshakeMessage",
	"FeedSubscriptionsReadyMessage",
	"GeometryComponent",
	"CustomPluginComponent",
	"JSONValue",
	"ProtocolRevision",
	"ResourceType",
	"RFC3339Timestamp",
}

func runtimeValidatorSource(g *typeScriptGenerator) (string, error) {
	var builder strings.Builder
	generated := false
	for _, name := range runtimeValidatorNames(g) {
		schema, ok := g.defs[name]
		if !ok {
			continue
		}
		generated = true
		check := "atlasProtocolIsJSONValue(value)"
		var err error
		if name != "JSONValue" {
			check, err = g.runtimeValidatorExpressionWithRefs("value", schema, map[string]bool{name: true})
		}
		if err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
		}
		if name == "CommandCatalog" {
			check = "(" + check + " && atlasProtocolHasValidCommandCatalogSemantics(value))"
		}
		if name == "MapArea" {
			check = "(" + check + " && atlasProtocolHasValidMapAreaSemantics(value))"
		}
		if name == "SpatialOperationResult" {
			check = "(" + check + " && atlasProtocolHasUniqueSpatialFeatureIDs(value))"
		}
		builder.WriteString("export function ")
		builder.WriteString(validatorFunctionName(name))
		builder.WriteString("(value: unknown): value is ")
		builder.WriteString(name)
		builder.WriteString(" {\n")
		builder.WriteString("  return ")
		builder.WriteString(check)
		builder.WriteString(";\n")
		builder.WriteString("}\n\n")
	}
	if !generated {
		return "", nil
	}
	builder.WriteString(runtimeValidatorHelpersSource())
	return builder.String(), nil
}

func runtimeValidatorNames(g *typeScriptGenerator) []string {
	names := append([]string(nil), runtimeValidatorTypeNames...)
	known := make(map[string]bool, len(names))
	for _, name := range names {
		known[name] = true
	}
	requests := make([]string, 0)
	for name := range g.defs {
		if strings.HasSuffix(name, "Request") && !known[name] {
			requests = append(requests, name)
		}
	}
	sort.Strings(requests)
	return append(names, requests...)
}

func validatorFunctionName(typeName string) string {
	return "is" + typeName
}

func hasRuntimeValidator(typeName string) bool {
	for _, name := range runtimeValidatorTypeNames {
		if name == typeName {
			return true
		}
	}
	return false
}

func (g *typeScriptGenerator) runtimeValidatorExpressionWithRefs(valueExpr string, schema typeScriptSchema, seenRefs map[string]bool) (string, error) {
	if ref, ok := schema["$ref"].(string); ok {
		refExpression, err := g.runtimeRefValidatorExpression(valueExpr, ref, seenRefs)
		if err != nil {
			return "", err
		}
		siblingSchema := cloneSchemaWithoutKey(schema, "$ref")
		if len(siblingSchema) == 0 {
			return refExpression, nil
		}
		siblingExpression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, siblingSchema, seenRefs)
		if err != nil {
			return "", err
		}
		return "(" + refExpression + " && " + siblingExpression + ")", nil
	}
	if allOf, ok := schema["allOf"].([]any); ok {
		parts := make([]string, 0, len(allOf))
		siblingSchema := cloneSchemaWithoutKey(schema, "allOf")
		if len(siblingSchema) > 0 {
			expression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, siblingSchema, seenRefs)
			if err != nil {
				return "", err
			}
			parts = append(parts, expression)
		}
		for index, raw := range allOf {
			item, ok := raw.(map[string]any)
			if !ok {
				return "", fmt.Errorf("allOf[%d] is not a schema", index)
			}
			expression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, item, seenRefs)
			if err != nil {
				return "", fmt.Errorf("allOf[%d]: %w", index, err)
			}
			parts = append(parts, expression)
		}
		if len(parts) == 0 {
			return "", fmt.Errorf("allOf has no schemas")
		}
		return "(" + strings.Join(parts, " && ") + ")", nil
	}
	if rawIf, ok := schema["if"]; ok {
		ifSchema, ok := rawIf.(map[string]any)
		if !ok {
			return "", fmt.Errorf("if is not a schema")
		}
		condition, err := g.runtimeValidatorExpressionWithRefs(valueExpr, ifSchema, seenRefs)
		if err != nil {
			return "", fmt.Errorf("if: %w", err)
		}
		baseSchema := cloneSchemaWithoutKey(cloneSchemaWithoutKey(cloneSchemaWithoutKey(schema, "if"), "then"), "else")
		parts := make([]string, 0, 3)
		if len(baseSchema) > 0 {
			base, err := g.runtimeValidatorExpressionWithRefs(valueExpr, baseSchema, seenRefs)
			if err != nil {
				return "", err
			}
			parts = append(parts, base)
		}
		if rawThen, ok := schema["then"]; ok {
			thenSchema, ok := rawThen.(map[string]any)
			if !ok {
				return "", fmt.Errorf("then is not a schema")
			}
			thenExpression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, thenSchema, seenRefs)
			if err != nil {
				return "", fmt.Errorf("then: %w", err)
			}
			parts = append(parts, "(!("+condition+") || ("+thenExpression+"))")
		}
		if rawElse, ok := schema["else"]; ok {
			elseSchema, ok := rawElse.(map[string]any)
			if !ok {
				return "", fmt.Errorf("else is not a schema")
			}
			elseExpression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, elseSchema, seenRefs)
			if err != nil {
				return "", fmt.Errorf("else: %w", err)
			}
			parts = append(parts, "(("+condition+") || ("+elseExpression+"))")
		}
		if len(parts) == 0 {
			return "", fmt.Errorf("if has no base, then, or else schema")
		}
		return "(" + strings.Join(parts, " && ") + ")", nil
	}
	for _, keyword := range []string{"dependentRequired", "minLength", "oneOf"} {
		if _, ok := schema[keyword]; ok {
			return "", fmt.Errorf("unsupported runtime validator keyword %q", keyword)
		}
	}
	if anyOf, ok := schema["anyOf"].([]any); ok {
		return g.runtimeUnionValidatorExpression(valueExpr, anyOf, seenRefs)
	}
	if value, ok := schema["const"]; ok {
		return valueExpr + " === " + literalValue(value), nil
	}
	if enumValues, ok := schema["enum"].([]any); ok {
		parts := make([]string, 0, len(enumValues))
		for _, value := range enumValues {
			parts = append(parts, valueExpr+" === "+literalValue(value))
		}
		if len(parts) == 0 {
			return "", fmt.Errorf("runtime enum has no values")
		}
		return "(" + strings.Join(parts, " || ") + ")", nil
	}

	switch schemaTypeValue(schema) {
	case "null":
		return valueExpr + " === null", nil
	case "string":
		return runtimeStringValidatorExpression(valueExpr, schema), nil
	case "integer":
		return runtimeNumberValidatorExpression(valueExpr, schema, true), nil
	case "number":
		return runtimeNumberValidatorExpression(valueExpr, schema, false), nil
	case "boolean":
		return "typeof " + valueExpr + " === \"boolean\"", nil
	case "array":
		return g.runtimeArrayValidatorExpression(valueExpr, schema, seenRefs)
	case "object":
		return g.runtimeObjectValidatorExpression(valueExpr, schema, seenRefs)
	default:
		if _, ok := schema["properties"].(map[string]any); ok {
			return g.runtimeObjectValidatorExpression(valueExpr, schema, seenRefs)
		}
		if _, ok := schema["patternProperties"].(map[string]any); ok {
			return g.runtimeObjectValidatorExpression(valueExpr, schema, seenRefs)
		}
		if _, ok := schema["additionalProperties"].(map[string]any); ok {
			return g.runtimeObjectValidatorExpression(valueExpr, schema, seenRefs)
		}
		if _, ok := schema["additionalProperties"].(bool); ok {
			return g.runtimeObjectValidatorExpression(valueExpr, schema, seenRefs)
		}
		return "", fmt.Errorf("unsupported runtime validator schema: %s", summarizeTypeScriptSchema(schema))
	}
}

func (g *typeScriptGenerator) runtimeRefValidatorExpression(valueExpr string, ref string, seenRefs map[string]bool) (string, error) {
	name := typeNameFromRef(ref)
	if !seenRefs[name] && hasRuntimeValidator(name) {
		if _, ok := g.defs[name]; ok {
			return validatorFunctionName(name) + "(" + valueExpr + ")", nil
		}
	}
	switch name {
	case "JSONValue":
		return "atlasProtocolIsJSONValue(" + valueExpr + ")", nil
	case "NonEmptyString":
		return "atlasProtocolIsNonEmptyString(" + valueExpr + ")", nil
	case "RFC3339Timestamp":
		return "atlasProtocolIsRFC3339String(" + valueExpr + ")", nil
	}
	schema, ok := g.defs[name]
	if !ok {
		return "", fmt.Errorf("unsupported runtime validator ref %q", ref)
	}
	if seenRefs[name] {
		return "", fmt.Errorf("cyclic runtime validator ref %q", ref)
	}
	nextSeenRefs := cloneSeenRefs(seenRefs)
	nextSeenRefs[name] = true
	expression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, schema, nextSeenRefs)
	if err != nil {
		return "", err
	}
	if name == "GeoJSONPolygon" {
		expression = "(" + expression + " && atlasProtocolHasValidPolygonSemantics(" + valueExpr + "))"
	}
	if name == "GeoJSONMultiPolygon" {
		expression = "(" + expression + " && atlasProtocolHasValidMultiPolygonSemantics(" + valueExpr + "))"
	}
	return expression, nil
}

func runtimeStringValidatorExpression(valueExpr string, schema typeScriptSchema) string {
	checks := []string{}
	if format, ok := schema["format"].(string); ok {
		switch format {
		case "date-time":
			checks = append(checks, "atlasProtocolIsRFC3339String("+valueExpr+")")
		case "uri":
			checks = append(checks, "atlasProtocolIsURIString("+valueExpr+")")
		default:
			checks = append(checks, "typeof "+valueExpr+" === \"string\"")
		}
	} else {
		checks = append(checks, "typeof "+valueExpr+" === \"string\"")
	}
	if pattern, ok := schema["pattern"].(string); ok {
		checks = append(checks, "atlasProtocolStringMatches("+valueExpr+", "+jsonString(pattern)+")")
	}
	if maxLength, ok := schema["maxLength"].(float64); ok {
		checks = append(checks, "Array.from("+valueExpr+").length <= "+jsonNumber(maxLength))
	}
	return strings.Join(checks, " && ")
}

func runtimeNumberValidatorExpression(valueExpr string, schema typeScriptSchema, integer bool) string {
	checks := []string{"typeof " + valueExpr + " === \"number\"", "Number.isFinite(" + valueExpr + ")"}
	if integer {
		checks = append(checks, "Number.isInteger("+valueExpr+")")
	}
	if minimum, ok := schema["minimum"].(float64); ok {
		checks = append(checks, valueExpr+" >= "+jsonNumber(minimum))
	}
	if maximum, ok := schema["maximum"].(float64); ok {
		checks = append(checks, valueExpr+" <= "+jsonNumber(maximum))
	}
	if exclusiveMinimum, ok := schema["exclusiveMinimum"].(float64); ok {
		checks = append(checks, valueExpr+" > "+jsonNumber(exclusiveMinimum))
	}
	if exclusiveMaximum, ok := schema["exclusiveMaximum"].(float64); ok {
		checks = append(checks, valueExpr+" < "+jsonNumber(exclusiveMaximum))
	}
	return strings.Join(checks, " && ")
}

func (g *typeScriptGenerator) runtimeArrayValidatorExpression(valueExpr string, schema typeScriptSchema, seenRefs map[string]bool) (string, error) {
	checks := []string{"Array.isArray(" + valueExpr + ")"}
	if minItems, ok := schema["minItems"].(float64); ok {
		checks = append(checks, valueExpr+".length >= "+jsonNumber(minItems))
	}
	if maxItems, ok := schema["maxItems"].(float64); ok {
		checks = append(checks, valueExpr+".length <= "+jsonNumber(maxItems))
	}
	prefixItemCount := 0
	if prefixItems, ok := schema["prefixItems"].([]any); ok {
		prefixItemCount = len(prefixItems)
		for index, item := range prefixItems {
			itemSchema, ok := item.(map[string]any)
			if !ok {
				return "", fmt.Errorf("prefix item %d is not a schema", index)
			}
			itemCheck, err := g.runtimeValidatorExpressionWithRefs(valueExpr+"["+strconv.Itoa(index)+"]", itemSchema, seenRefs)
			if err != nil {
				return "", fmt.Errorf("prefix item %d: %w", index, err)
			}
			checks = append(checks, "("+valueExpr+".length <= "+strconv.Itoa(index)+" || "+itemCheck+")")
		}
	}
	if itemSchema, ok := schema["items"].(map[string]any); ok {
		itemCheck, err := g.runtimeValidatorExpressionWithRefs("item", itemSchema, seenRefs)
		if err != nil {
			return "", err
		}
		if prefixItemCount > 0 {
			checks = append(checks, valueExpr+".slice("+strconv.Itoa(prefixItemCount)+").every((item) => "+itemCheck+")")
		} else {
			checks = append(checks, valueExpr+".every((item) => "+itemCheck+")")
		}
	}
	return strings.Join(checks, " && "), nil
}

func (g *typeScriptGenerator) runtimeObjectValidatorExpression(valueExpr string, schema typeScriptSchema, seenRefs map[string]bool) (string, error) {
	props, _ := schema["properties"].(map[string]any)
	patterns, _ := schema["patternProperties"].(map[string]any)
	required := requiredProperties(schema)

	keys := make([]string, 0, len(props))
	for key := range props {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	checks := []string{"atlasProtocolIsRecord(" + valueExpr + ")"}
	if minPropertiesOne(schema) {
		checks = append(checks, "Object.keys("+valueExpr+").length >= 1")
	}
	for _, key := range keys {
		propSchema, ok := props[key].(map[string]any)
		if !ok {
			return "", fmt.Errorf("property %s is not a schema", key)
		}
		propExpr := valueExpr + "[" + jsonString(key) + "]"
		check, err := g.runtimeValidatorExpressionWithRefs(propExpr, propSchema, seenRefs)
		if err != nil {
			return "", fmt.Errorf("property %s: %w", key, err)
		}
		if required[key] {
			checks = append(checks, "(atlasProtocolHasOwn("+valueExpr+", "+jsonString(key)+") && "+check+")")
		} else {
			checks = append(checks, "(!atlasProtocolHasOwn("+valueExpr+", "+jsonString(key)+") || "+check+")")
		}
	}
	entriesCheck, err := g.runtimeObjectEntriesValidatorExpression(valueExpr, keys, patterns, schema["additionalProperties"], seenRefs)
	if err != nil {
		return "", err
	}
	if entriesCheck != "" {
		checks = append(checks, entriesCheck)
	}
	return "(" + strings.Join(checks, " && ") + ")", nil
}

func (g *typeScriptGenerator) runtimeObjectEntriesValidatorExpression(valueExpr string, propKeys []string, patterns map[string]any, additional any, seenRefs map[string]bool) (string, error) {
	if len(patterns) == 0 {
		switch typed := additional.(type) {
		case nil:
			return "", nil
		case bool:
			if typed {
				return "", nil
			}
			return "Object.keys(" + valueExpr + ").every((key) => atlasProtocolKnownKeys(" + jsonStringSlice(propKeys) + ", key))", nil
		case map[string]any:
			check, err := g.runtimeValidatorExpressionWithRefs("item", typed, seenRefs)
			if err != nil {
				return "", err
			}
			return "Object.entries(" + valueExpr + ").every(([key, item]) => atlasProtocolKnownKeys(" + jsonStringSlice(propKeys) + ", key) || " + check + ")", nil
		default:
			return "", fmt.Errorf("unsupported additionalProperties %T", additional)
		}
	}

	patternKeys := make([]string, 0, len(patterns))
	for key := range patterns {
		patternKeys = append(patternKeys, key)
	}
	sort.Strings(patternKeys)

	patternMatches := make([]string, 0, len(patternKeys))
	patternRequirements := make([]string, 0, len(patternKeys))
	for _, pattern := range patternKeys {
		patternSchema, ok := patterns[pattern].(map[string]any)
		if !ok {
			return "", fmt.Errorf("pattern %s is not a schema", pattern)
		}
		itemCheck, err := g.runtimeValidatorExpressionWithRefs("item", patternSchema, seenRefs)
		if err != nil {
			return "", fmt.Errorf("pattern %s: %w", pattern, err)
		}
		match := "atlasProtocolKeyMatches(key, " + jsonString(pattern) + ")"
		patternMatches = append(patternMatches, match)
		patternRequirements = append(patternRequirements, "(!"+match+" || ("+itemCheck+"))")
	}

	fallback := "true"
	switch typed := additional.(type) {
	case nil:
		fallback = "true"
	case bool:
		if !typed {
			fallback = "false"
		}
	case map[string]any:
		check, err := g.runtimeValidatorExpressionWithRefs("item", typed, seenRefs)
		if err != nil {
			return "", err
		}
		fallback = check
	default:
		return "", fmt.Errorf("unsupported additionalProperties %T", additional)
	}

	knownKeys := "atlasProtocolKnownKeys(" + jsonStringSlice(propKeys) + ", key)"
	patternMatched := "(" + strings.Join(patternMatches, " || ") + ")"
	patternValid := "(" + strings.Join(patternRequirements, " && ") + ")"
	return "Object.entries(" + valueExpr + ").every(([key, item]) => " + knownKeys + " || (" + patternMatched + " ? " + patternValid + " : " + fallback + "))", nil
}

func (g *typeScriptGenerator) runtimeUnionValidatorExpression(valueExpr string, items []any, seenRefs map[string]bool) (string, error) {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		schema, ok := item.(map[string]any)
		if !ok {
			return "", fmt.Errorf("unsupported runtime union item %T", item)
		}
		expression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, schema, seenRefs)
		if err != nil {
			return "", err
		}
		parts = append(parts, expression)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("runtime union has no schema branches")
	}
	return "(" + strings.Join(uniqueStrings(parts), " || ") + ")", nil
}
