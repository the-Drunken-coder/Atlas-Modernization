package artifacts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

func jsonStringSlice(values []string) string {
	encoded, err := json.Marshal(values)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func requiredProperties(schema typeScriptSchema) map[string]bool {
	required := map[string]bool{}
	values, ok := schema["required"].([]any)
	if !ok {
		return required
	}
	for _, value := range values {
		if key, ok := value.(string); ok {
			required[key] = true
		}
	}
	return required
}

func schemaTypeValue(schema typeScriptSchema) string {
	if value, ok := schema["type"].(string); ok {
		return value
	}
	return ""
}

func cloneSchemaWithoutKey(schema typeScriptSchema, without string) typeScriptSchema {
	out := make(typeScriptSchema, len(schema))
	for key, value := range schema {
		if key == without {
			continue
		}
		out[key] = value
	}
	return out
}

func typeNameFromRef(ref string) string {
	const prefix = "#/$defs/"
	if strings.HasPrefix(ref, prefix) {
		raw, err := url.PathUnescape(strings.TrimPrefix(ref, prefix))
		if err == nil {
			return typeName(raw)
		}
		return typeName(strings.TrimPrefix(ref, prefix))
	}
	return typeName(ref)
}

var nonIdentifierChars = regexp.MustCompile(`[^A-Za-z0-9]+`)

func typeName(raw string) string {
	raw = strings.TrimPrefix(raw, "#")
	raw = nonIdentifierChars.ReplaceAllString(raw, " ")
	parts := strings.Fields(raw)
	if len(parts) == 0 {
		return "Unknown"
	}
	for i, part := range parts {
		parts[i] = upperFirst(part)
	}
	name := strings.Join(parts, "")
	if len(name) > 0 && unicode.IsDigit(rune(name[0])) {
		name = "Atlas" + name
	}
	return name
}

func upperFirst(value string) string {
	if value == "" {
		return value
	}
	runes := []rune(value)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

func literalType(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case string:
		return jsonString(typed)
	case float64:
		return fmt.Sprintf("%v", typed)
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, jsonString(key)+": "+literalType(typed[key]))
		}
		return "{ " + strings.Join(parts, "; ") + " }"
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, literalType(item))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return jsonString(fmt.Sprint(typed))
	}
}

func literalValue(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func jsonNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func jsonString(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func formatTypeScript(source []byte) []byte {
	formatted := bytes.ReplaceAll(source, []byte("\t"), []byte("  "))
	return append(bytes.TrimRight(formatted, "\n"), '\n')
}
