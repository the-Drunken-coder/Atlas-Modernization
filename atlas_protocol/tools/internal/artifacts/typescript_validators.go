package artifacts

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

var requestValidatorTypeNames = []string{
	"EntityCreateRequest",
	"EntityUpdateRequest",
	"ObjectCreateRequest",
	"ObjectUpdateRequest",
	"TaskCreateRequest",
	"TaskUpdateRequest",
}

func requestValidatorSource(g *typeScriptGenerator) (string, error) {
	var builder strings.Builder
	generated := false
	for _, name := range requestValidatorTypeNames {
		schema, ok := g.defs[name]
		if !ok {
			continue
		}
		generated = true
		check, err := g.runtimeValidatorExpression("value", schema)
		if err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
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

func validatorFunctionName(typeName string) string {
	return "is" + typeName
}

func (g *typeScriptGenerator) runtimeValidatorExpression(valueExpr string, schema typeScriptSchema) (string, error) {
	return g.runtimeValidatorExpressionWithRefs(valueExpr, schema, map[string]bool{})
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
	if oneOf, ok := schema["oneOf"].([]any); ok {
		return g.runtimeUnionValidatorExpression(valueExpr, oneOf, seenRefs)
	}
	if anyOf, ok := schema["anyOf"].([]any); ok {
		return g.runtimeUnionValidatorExpression(valueExpr, anyOf, seenRefs)
	}
	if allOf, ok := schema["allOf"].([]any); ok {
		return g.runtimeAllOfValidatorExpression(valueExpr, allOf, seenRefs)
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
	return g.runtimeValidatorExpressionWithRefs(valueExpr, schema, nextSeenRefs)
}

func runtimeStringValidatorExpression(valueExpr string, schema typeScriptSchema) string {
	if format, ok := schema["format"].(string); ok && format == "date-time" {
		return "atlasProtocolIsRFC3339String(" + valueExpr + ")"
	}
	if _, ok := schema["pattern"].(string); ok {
		return "atlasProtocolIsNonEmptyString(" + valueExpr + ")"
	}
	if minLength, ok := schema["minLength"].(float64); ok && minLength > 0 {
		return "atlasProtocolIsNonEmptyString(" + valueExpr + ")"
	}
	return "typeof " + valueExpr + " === \"string\""
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
	dependencies, err := runtimeDependentRequiredExpressions(valueExpr, schema)
	if err != nil {
		return "", err
	}
	checks = append(checks, dependencies...)

	entriesCheck, err := g.runtimeObjectEntriesValidatorExpression(valueExpr, keys, patterns, schema["additionalProperties"], seenRefs)
	if err != nil {
		return "", err
	}
	if entriesCheck != "" {
		checks = append(checks, entriesCheck)
	}
	return "(" + strings.Join(checks, " && ") + ")", nil
}

func runtimeDependentRequiredExpressions(valueExpr string, schema typeScriptSchema) ([]string, error) {
	raw, ok := schema["dependentRequired"].(map[string]any)
	if !ok {
		return nil, nil
	}
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	checks := make([]string, 0, len(keys))
	for _, key := range keys {
		rawDependencies, ok := raw[key].([]any)
		if !ok {
			return nil, fmt.Errorf("dependentRequired[%s] is not an array", key)
		}
		dependencies := make([]string, 0, len(rawDependencies))
		for _, rawDependency := range rawDependencies {
			dependency, ok := rawDependency.(string)
			if !ok {
				return nil, fmt.Errorf("dependentRequired[%s] contains non-string dependency", key)
			}
			dependencies = append(dependencies, dependency)
		}
		sort.Strings(dependencies)
		if len(dependencies) == 0 {
			continue
		}
		dependencyChecks := make([]string, 0, len(dependencies))
		for _, dependency := range dependencies {
			dependencyChecks = append(dependencyChecks, "atlasProtocolHasOwn("+valueExpr+", "+jsonString(dependency)+")")
		}
		checks = append(checks, "(!atlasProtocolHasOwn("+valueExpr+", "+jsonString(key)+") || ("+strings.Join(dependencyChecks, " && ")+"))")
	}
	return checks, nil
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

	patternChecks := make([]string, 0, len(patternKeys))
	for _, pattern := range patternKeys {
		patternSchema, ok := patterns[pattern].(map[string]any)
		if !ok {
			return "", fmt.Errorf("pattern %s is not a schema", pattern)
		}
		itemCheck, err := g.runtimeValidatorExpressionWithRefs("item", patternSchema, seenRefs)
		if err != nil {
			return "", fmt.Errorf("pattern %s: %w", pattern, err)
		}
		patternChecks = append(patternChecks, "(atlasProtocolKeyMatches(key, "+jsonString(pattern)+") && "+itemCheck+")")
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

	parts := []string{"atlasProtocolKnownKeys(" + jsonStringSlice(propKeys) + ", key)"}
	parts = append(parts, patternChecks...)
	parts = append(parts, fallback)
	return "Object.entries(" + valueExpr + ").every(([key, item]) => " + strings.Join(parts, " || ") + ")", nil
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

func (g *typeScriptGenerator) runtimeAllOfValidatorExpression(valueExpr string, items []any, seenRefs map[string]bool) (string, error) {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		schema, ok := item.(map[string]any)
		if !ok {
			return "", fmt.Errorf("unsupported runtime allOf item %T", item)
		}
		expression, err := g.runtimeValidatorExpressionWithRefs(valueExpr, schema, seenRefs)
		if err != nil {
			return "", err
		}
		parts = append(parts, expression)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("runtime allOf has no schema branches")
	}
	return "(" + strings.Join(uniqueStrings(parts), " && ") + ")", nil
}
