package artifacts

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type schemaObjectVariant struct {
	properties map[string]map[string]any
	required   map[string]bool
	closed     bool
}

type schemaGoField struct {
	typeName string
	optional bool
}

type goSchemaContext struct {
	defs        map[string]any
	structTypes map[string]bool
	enumTypes   map[string]bool
	enumByField map[string]string
	enumValues  map[string]map[string]bool
}

func (context goSchemaContext) structFields(definitions []string) (map[string]schemaGoField, error) {
	var variants []schemaObjectVariant
	for _, definition := range definitions {
		raw, ok := context.defs[definition].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema definition %s not found", definition)
		}
		definitionVariants, err := schemaObjectVariants(raw, context.defs, map[string]bool{})
		if err != nil {
			return nil, fmt.Errorf("schema definition %s: %w", definition, err)
		}
		variants = append(variants, definitionVariants...)
	}
	if len(variants) == 0 {
		return nil, fmt.Errorf("schema definitions %v contain no object variants", definitions)
	}
	for _, variant := range variants {
		if !variant.closed {
			return nil, fmt.Errorf("schema object allows additional properties that the Go struct cannot represent")
		}
	}

	fieldSchemas := make(map[string][]map[string]any)
	requiredCounts := make(map[string]int)
	for _, variant := range variants {
		for field, schema := range variant.properties {
			fieldSchemas[field] = append(fieldSchemas[field], schema)
			if variant.required[field] {
				requiredCounts[field]++
			}
		}
	}

	fields := make(map[string]schemaGoField, len(fieldSchemas))
	for field, schemas := range fieldSchemas {
		typeName, err := context.fieldType(field, schemas)
		if err != nil {
			return nil, fmt.Errorf("field %s: %w", field, err)
		}
		fields[field] = schemaGoField{typeName: typeName, optional: requiredCounts[field] != len(variants)}
	}
	return fields, nil
}

func (context goSchemaContext) fieldType(field string, schemas []map[string]any) (string, error) {
	if enumType := context.enumByField[field]; enumType != "" {
		for _, schema := range schemas {
			typeName, err := context.schemaType(schema, map[string]bool{})
			if err != nil {
				return "", err
			}
			if typeName != "string" && typeName != enumType {
				return "", fmt.Errorf("schema type %s is incompatible with enum %s", typeName, enumType)
			}
			values, finite, err := schemaStringValuesFromSchema(context.defs, schema, "", map[string]bool{})
			if err != nil {
				return "", err
			}
			if !finite {
				return "", fmt.Errorf("schema field is not a finite string domain for Go enum %s", enumType)
			}
			for _, value := range values {
				if !context.enumValues[enumType][value] {
					return "", fmt.Errorf("schema value %q is missing from Go enum %s", value, enumType)
				}
			}
		}
		return enumType, nil
	}

	types := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		typeName, err := context.schemaType(schema, map[string]bool{})
		if err != nil {
			return "", err
		}
		types = append(types, typeName)
	}
	return mergeGoTypes(types), nil
}

func (context goSchemaContext) schemaType(schema map[string]any, seen map[string]bool) (string, error) {
	if ref, ok := schema["$ref"].(string); ok {
		definition, err := schemaDefinitionFromRef(ref)
		if err != nil {
			return "", err
		}
		if context.enumTypes[definition] || context.structTypes[definition] || definition == "JSONValue" {
			return definition, nil
		}
		if seen[definition] {
			return "JSONValue", nil
		}
		resolved, ok := context.defs[definition].(map[string]any)
		if !ok {
			return "", fmt.Errorf("schema definition %s not found", definition)
		}
		nextSeen := cloneBoolMap(seen)
		nextSeen[definition] = true
		return context.schemaType(resolved, nextSeen)
	}

	for _, keyword := range []string{"anyOf", "oneOf"} {
		if rawVariants, ok := schema[keyword].([]any); ok {
			types := make([]string, 0, len(rawVariants))
			for _, rawVariant := range rawVariants {
				variant, ok := rawVariant.(map[string]any)
				if !ok {
					return "", fmt.Errorf("%s contains a non-object schema", keyword)
				}
				typeName, err := context.schemaType(variant, cloneBoolMap(seen))
				if err != nil {
					return "", err
				}
				types = append(types, typeName)
			}
			return mergeGoTypes(types), nil
		}
	}
	if constant, exists := schema["const"]; exists {
		return goTypeForJSONValue(constant), nil
	}
	if enum, ok := schema["enum"].([]any); ok && len(enum) > 0 {
		types := make([]string, 0, len(enum))
		for _, value := range enum {
			types = append(types, goTypeForJSONValue(value))
		}
		return mergeGoTypes(types), nil
	}

	schemaType, _ := schema["type"].(string)
	switch schemaType {
	case "null":
		return "nil", nil
	case "boolean":
		return "bool", nil
	case "string":
		return "string", nil
	case "integer":
		return "int64", nil
	case "number":
		return "float64", nil
	case "array":
		items, ok := schema["items"].(map[string]any)
		if !ok {
			return "[]JSONValue", nil
		}
		itemType, err := context.schemaType(items, cloneBoolMap(seen))
		if err != nil {
			return "", err
		}
		return "[]" + itemType, nil
	case "object":
		if additional, ok := schema["additionalProperties"].(map[string]any); ok {
			valueType, err := context.schemaType(additional, cloneBoolMap(seen))
			if err != nil {
				return "", err
			}
			return "map[string]" + valueType, nil
		}
		return "map[string]JSONValue", nil
	case "":
		if _, ok := schema["properties"]; ok {
			return "map[string]JSONValue", nil
		}
	}
	return "", fmt.Errorf("unsupported schema type %q", schemaType)
}

func schemaObjectVariants(schema map[string]any, defs map[string]any, seen map[string]bool) ([]schemaObjectVariant, error) {
	if ref, ok := schema["$ref"].(string); ok {
		if err := validateSchemaKeywords(schema, "go struct object shape", "$ref"); err != nil {
			return nil, err
		}
		definition, err := schemaDefinitionFromRef(ref)
		if err != nil {
			return nil, err
		}
		if seen[definition] {
			return nil, fmt.Errorf("recursive object definition %s is unsupported", definition)
		}
		resolved, ok := defs[definition].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema definition %s not found", definition)
		}
		nextSeen := cloneBoolMap(seen)
		nextSeen[definition] = true
		return schemaObjectVariants(resolved, defs, nextSeen)
	}
	for _, keyword := range []string{"anyOf"} {
		if rawVariants, ok := schema[keyword].([]any); ok {
			if err := validateSchemaKeywords(schema, "go struct object shape", keyword); err != nil {
				return nil, err
			}
			var variants []schemaObjectVariant
			for _, rawVariant := range rawVariants {
				variant, ok := rawVariant.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("%s contains a non-object schema", keyword)
				}
				resolved, err := schemaObjectVariants(variant, defs, cloneBoolMap(seen))
				if err != nil {
					return nil, err
				}
				variants = append(variants, resolved...)
			}
			return variants, nil
		}
	}
	if _, ok := schema["oneOf"]; ok {
		return nil, fmt.Errorf("oneOf object unions are not supported for Go struct parity")
	}
	if constant, ok := schema["const"].(map[string]any); ok {
		if err := validateSchemaKeywords(schema, "go struct object shape", "const"); err != nil {
			return nil, err
		}
		properties := make(map[string]map[string]any, len(constant))
		required := make(map[string]bool, len(constant))
		for key, value := range constant {
			properties[key] = map[string]any{"const": value}
			required[key] = true
		}
		return []schemaObjectVariant{{properties: properties, required: required, closed: true}}, nil
	}
	properties := make(map[string]map[string]any)
	if rawProperties, ok := schema["properties"].(map[string]any); ok {
		for key, rawProperty := range rawProperties {
			property, ok := rawProperty.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("property %s is not a schema object", key)
			}
			properties[key] = property
		}
	}
	if schema["type"] != "object" && len(properties) == 0 {
		return nil, fmt.Errorf("expected object schema")
	}
	required := make(map[string]bool)
	if rawRequired, ok := schema["required"].([]any); ok {
		for _, rawField := range rawRequired {
			field, ok := rawField.(string)
			if !ok {
				return nil, fmt.Errorf("required contains a non-string field")
			}
			required[field] = true
		}
	}
	for field := range required {
		if _, ok := properties[field]; !ok {
			return nil, fmt.Errorf("required field %s has no property schema", field)
		}
	}
	if patterns, ok := schema["patternProperties"].(map[string]any); ok && len(patterns) > 0 {
		return nil, fmt.Errorf("pattern properties cannot be represented by a fixed Go struct")
	}
	if err := validateSchemaKeywords(schema, "go struct object shape", "additionalProperties", "minProperties", "properties", "required", "type"); err != nil {
		return nil, err
	}
	additionalProperties, explicit := schema["additionalProperties"].(bool)
	return []schemaObjectVariant{{properties: properties, required: required, closed: explicit && !additionalProperties}}, nil
}

func schemaStringValues(defs map[string]any, definitions []string, property string) ([]string, error) {
	var values []string
	for _, definition := range definitions {
		schema, ok := defs[definition].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("schema definition %s not found", definition)
		}
		definitionValues, finite, err := schemaStringValuesFromSchema(defs, schema, property, map[string]bool{})
		if err != nil {
			return nil, err
		}
		if !finite {
			return nil, fmt.Errorf("schema definition %s does not define a finite string domain for property %q", definition, property)
		}
		values = append(values, definitionValues...)
	}
	values = sortedUniqueStrings(values)
	if len(values) == 0 {
		return nil, fmt.Errorf("schema definitions %v contain no string values for property %q", definitions, property)
	}
	return values, nil
}

func schemaStringValuesFromSchema(defs map[string]any, schema map[string]any, property string, seen map[string]bool) ([]string, bool, error) {
	if ref, ok := schema["$ref"].(string); ok {
		if err := validateSchemaKeywords(schema, "finite string domain", "$ref"); err != nil {
			return nil, false, err
		}
		definition, err := schemaDefinitionFromRef(ref)
		if err != nil {
			return nil, false, err
		}
		key := definition + "\x00" + property
		if seen[key] {
			return nil, false, fmt.Errorf("recursive string domain through schema definition %s", definition)
		}
		resolved, ok := defs[definition].(map[string]any)
		if !ok {
			return nil, false, fmt.Errorf("schema definition %s not found", definition)
		}
		nextSeen := cloneBoolMap(seen)
		nextSeen[key] = true
		return schemaStringValuesFromSchema(defs, resolved, property, nextSeen)
	}

	for _, keyword := range []string{"anyOf"} {
		if variants, ok := schema[keyword].([]any); ok {
			if err := validateSchemaKeywords(schema, "finite string domain", keyword); err != nil {
				return nil, false, err
			}
			var values []string
			for _, rawVariant := range variants {
				variant, ok := rawVariant.(map[string]any)
				if !ok {
					return nil, false, fmt.Errorf("%s contains a non-object schema", keyword)
				}
				variantValues, finite, err := schemaStringValuesFromSchema(defs, variant, property, cloneBoolMap(seen))
				if err != nil {
					return nil, false, err
				}
				if !finite {
					return nil, false, nil
				}
				values = append(values, variantValues...)
			}
			return sortedUniqueStrings(values), true, nil
		}
	}
	if _, ok := schema["oneOf"]; ok {
		return nil, false, fmt.Errorf("oneOf finite string domains are not supported")
	}
	if _, ok := schema["allOf"]; ok {
		return nil, false, fmt.Errorf("allOf string domains are not supported")
	}

	if property != "" {
		if constant, ok := schema["const"].(map[string]any); ok {
			if err := validateSchemaKeywords(schema, "finite string domain", "const"); err != nil {
				return nil, false, err
			}
			value, exists := constant[property]
			if !exists {
				return nil, false, nil
			}
			stringValue, ok := value.(string)
			if !ok {
				return nil, false, fmt.Errorf("const property %s is not a string", property)
			}
			return []string{stringValue}, true, nil
		}
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			return nil, false, nil
		}
		if err := validateSchemaKeywords(schema, "finite string domain", "additionalProperties", "properties", "required", "type"); err != nil {
			return nil, false, err
		}
		rawProperty, exists := properties[property]
		if !exists {
			return nil, false, nil
		}
		propertySchema, ok := rawProperty.(map[string]any)
		if !ok {
			return nil, false, fmt.Errorf("property %s is not a schema object", property)
		}
		return schemaStringValuesFromSchema(defs, propertySchema, "", cloneBoolMap(seen))
	}

	if constant, exists := schema["const"]; exists {
		if err := validateSchemaKeywords(schema, "finite string domain", "const"); err != nil {
			return nil, false, err
		}
		value, ok := constant.(string)
		if !ok {
			return nil, false, fmt.Errorf("const is not a string")
		}
		return []string{value}, true, nil
	}
	if enum, ok := schema["enum"].([]any); ok {
		if err := validateSchemaKeywords(schema, "finite string domain", "enum"); err != nil {
			return nil, false, err
		}
		if len(enum) == 0 {
			return nil, false, fmt.Errorf("enum has no values")
		}
		values := make([]string, 0, len(enum))
		for _, rawValue := range enum {
			value, ok := rawValue.(string)
			if !ok {
				return nil, false, fmt.Errorf("enum contains a non-string value")
			}
			values = append(values, value)
		}
		return sortedUniqueStrings(values), true, nil
	}
	return nil, false, nil
}

func validateSchemaKeywords(schema map[string]any, context string, allowed ...string) error {
	allowedKeywords := boolStringSet(allowed)
	for _, annotation := range []string{"$comment", "default", "deprecated", "description", "examples", "readOnly", "title", "writeOnly"} {
		allowedKeywords[annotation] = true
	}
	var unsupported []string
	for keyword := range schema {
		if !allowedKeywords[keyword] {
			unsupported = append(unsupported, keyword)
		}
	}
	if len(unsupported) == 0 {
		return nil
	}
	sort.Strings(unsupported)
	return fmt.Errorf("%s uses unsupported schema keywords %v", context, unsupported)
}

func schemaDefinitionFromRef(ref string) (string, error) {
	const prefix = "#/$defs/"
	if !strings.HasPrefix(ref, prefix) {
		return "", fmt.Errorf("unsupported schema reference %q", ref)
	}
	definition, err := url.PathUnescape(strings.TrimPrefix(ref, prefix))
	if err != nil {
		return "", fmt.Errorf("decode schema reference %q: %w", ref, err)
	}
	return definition, nil
}

func mergeGoTypes(types []string) string {
	nullable := false
	bases := make(map[string]bool)
	for _, typeName := range types {
		if typeName == "nil" {
			nullable = true
			continue
		}
		if strings.HasPrefix(typeName, "*") {
			nullable = true
			typeName = strings.TrimPrefix(typeName, "*")
		}
		bases[typeName] = true
	}
	if len(bases) != 1 {
		return "JSONValue"
	}
	var base string
	for typeName := range bases {
		base = typeName
	}
	if nullable && base != "JSONValue" {
		return "*" + base
	}
	return base
}

func goTypeForJSONValue(value any) string {
	switch value.(type) {
	case nil:
		return "nil"
	case bool:
		return "bool"
	case string:
		return "string"
	case float64:
		return "float64"
	case []any:
		return "[]JSONValue"
	case map[string]any:
		return "map[string]JSONValue"
	default:
		return "JSONValue"
	}
}

func cloneBoolMap(values map[string]bool) map[string]bool {
	clone := make(map[string]bool, len(values)+1)
	for key, value := range values {
		clone[key] = value
	}
	return clone
}
