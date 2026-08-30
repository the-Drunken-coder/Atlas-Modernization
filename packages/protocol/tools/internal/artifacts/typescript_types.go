package artifacts

import (
	"sort"
	"strings"
)

func (g *typeScriptGenerator) typeFor(schema typeScriptSchema, current string, indent int) string {
	if ref, ok := schema["$ref"].(string); ok {
		return typeNameFromRef(ref)
	}
	if value, ok := schema["const"]; ok {
		return literalType(value)
	}
	if enumValues, ok := schema["enum"].([]any); ok {
		parts := make([]string, 0, len(enumValues))
		for _, value := range enumValues {
			parts = append(parts, literalType(value))
		}
		return strings.Join(parts, " | ")
	}
	if anyOf, ok := schema["anyOf"].([]any); ok {
		return g.unionType(anyOf, current, indent)
	}
	if oneOf, ok := schema["oneOf"].([]any); ok {
		return g.unionType(oneOf, current, indent)
	}
	if allOf, ok := schema["allOf"].([]any); ok {
		items := make([]any, 0, len(allOf))
		if sibling := cloneSchemaWithoutKey(schema, "allOf"); len(sibling) > 0 {
			items = append(items, map[string]any(sibling))
		}
		items = append(items, allOf...)
		return g.intersectionType(items, current, indent)
	}

	switch schemaTypeValue(schema) {
	case "null":
		return "null"
	case "boolean":
		return "boolean"
	case "string":
		return "string"
	case "integer", "number":
		return "number"
	case "array":
		return g.arrayType(schema, current, indent)
	case "object":
		return g.objectType(schema, current, indent)
	default:
		if _, ok := schema["properties"].(map[string]any); ok {
			return g.objectType(schema, current, indent)
		}
		if _, ok := schema["patternProperties"].(map[string]any); ok {
			return g.objectType(schema, current, indent)
		}
		if _, ok := schema["additionalProperties"].(map[string]any); ok {
			return g.objectType(schema, current, indent)
		}
		return "unknown"
	}
}

func (g *typeScriptGenerator) unionType(items []any, current string, indent int) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if schema, ok := item.(map[string]any); ok {
			parts = append(parts, g.typeFor(schema, current, indent))
		}
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(uniqueStrings(parts), " | ")
}

func (g *typeScriptGenerator) intersectionType(items []any, current string, indent int) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if schema, ok := item.(map[string]any); ok {
			if part := g.typeFor(schema, current, indent); part != "unknown" {
				if strings.Contains(part, " | ") {
					part = "(" + part + ")"
				}
				parts = append(parts, part)
			}
		}
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(uniqueStrings(parts), " & ")
}

func (g *typeScriptGenerator) arrayType(schema typeScriptSchema, current string, indent int) string {
	if prefixItems, ok := schema["prefixItems"].([]any); ok {
		parts := make([]string, 0, len(prefixItems))
		for _, item := range prefixItems {
			if itemSchema, ok := item.(map[string]any); ok {
				parts = append(parts, g.typeFor(itemSchema, current, indent))
			}
		}
		if itemSchema, ok := schema["items"].(map[string]any); ok {
			itemType := g.typeFor(itemSchema, current, indent)
			if strings.Contains(itemType, " | ") || strings.Contains(itemType, " & ") {
				itemType = "(" + itemType + ")"
			}
			parts = append(parts, "..."+itemType+"[]")
		}
		return "[" + strings.Join(parts, ", ") + "]"
	}
	if itemSchema, ok := schema["items"].(map[string]any); ok {
		itemType := g.typeFor(itemSchema, current, indent)
		if strings.Contains(itemType, " | ") || strings.Contains(itemType, " & ") {
			itemType = "(" + itemType + ")"
		}
		return itemType + "[]"
	}
	return "unknown[]"
}

func (g *typeScriptGenerator) objectType(schema typeScriptSchema, current string, indent int) string {
	props, _ := schema["properties"].(map[string]any)
	required := requiredProperties(schema)
	additional := schema["additionalProperties"]
	patterns, _ := schema["patternProperties"].(map[string]any)

	if len(props) == 0 && len(patterns) == 0 {
		if additionalSchema, ok := additional.(map[string]any); ok {
			return "{ [key: string]: " + g.typeFor(additionalSchema, current, indent) + " }"
		}
		if allowed, ok := additional.(bool); ok && !allowed {
			return "Record<string, never>"
		}
		return "Record<string, unknown>"
	}

	innerIndent := strings.Repeat("\t", indent+1)
	outerIndent := strings.Repeat("\t", indent)
	var builder strings.Builder
	builder.WriteString("{\n")

	keys := make([]string, 0, len(props))
	for key := range props {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		propSchema, ok := props[key].(map[string]any)
		if !ok {
			continue
		}
		builder.WriteString(innerIndent)
		builder.WriteString(jsonString(key))
		if !required[key] {
			builder.WriteString("?")
		}
		builder.WriteString(": ")
		builder.WriteString(g.typeFor(propSchema, current, indent+1))
		builder.WriteString(";\n")
	}

	patternKeys := make([]string, 0, len(patterns))
	for key := range patterns {
		patternKeys = append(patternKeys, key)
	}
	sort.Strings(patternKeys)
	for _, key := range patternKeys {
		patternSchema, ok := patterns[key].(map[string]any)
		if !ok {
			continue
		}
		builder.WriteString(innerIndent)
		if strings.HasPrefix(key, "^custom_") {
			builder.WriteString("[key: `custom_${string}`]: ")
		} else {
			builder.WriteString("[key: string]: ")
		}
		indexTypes := []string{g.typeFor(patternSchema, current, indent+1)}
		if strings.HasPrefix(key, "^custom_") {
			for propertyName, property := range props {
				propertySchema, ok := property.(map[string]any)
				if ok && strings.HasPrefix(propertyName, "custom_") {
					indexTypes = append(indexTypes, g.typeFor(propertySchema, current, indent+1))
					if !required[propertyName] {
						indexTypes = append(indexTypes, "undefined")
					}
				}
			}
		}
		builder.WriteString(strings.Join(uniqueStrings(indexTypes), " | "))
		builder.WriteString(";\n")
	}

	if additionalSchema, ok := additional.(map[string]any); ok {
		builder.WriteString(innerIndent)
		builder.WriteString("[key: string]: ")
		builder.WriteString(g.additionalPropertyIndexType(additionalSchema, props, required, current, indent+1))
		builder.WriteString(";\n")
	}
	builder.WriteString(outerIndent)
	builder.WriteString("}")
	shape := builder.String()
	if minPropertiesOne(schema) && len(required) == 0 && len(keys) > 0 {
		return "RequireAtLeastOne<" + shape + ", " + quotedUnion(keys) + ">"
	}
	return shape
}

func (g *typeScriptGenerator) additionalPropertyIndexType(additionalSchema typeScriptSchema, props map[string]any, required map[string]bool, current string, indent int) string {
	parts := []string{g.typeFor(additionalSchema, current, indent)}
	hasOptional := false
	keys := make([]string, 0, len(props))
	for key := range props {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		propSchema, ok := props[key].(map[string]any)
		if !ok {
			continue
		}
		parts = append(parts, g.typeFor(propSchema, current, indent))
		if !required[key] {
			hasOptional = true
		}
	}
	if hasOptional {
		parts = append(parts, "undefined")
	}
	return strings.Join(uniqueStrings(parts), " | ")
}

func minPropertiesOne(schema typeScriptSchema) bool {
	value, ok := schema["minProperties"].(float64)
	return ok && value == 1
}

func quotedUnion(values []string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, jsonString(value))
	}
	return strings.Join(parts, " | ")
}
