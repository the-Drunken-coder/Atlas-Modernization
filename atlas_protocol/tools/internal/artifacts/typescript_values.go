package artifacts

import (
	"fmt"
	"strings"
)

func resourceTypeValuesSource(g *typeScriptGenerator) (string, error) {
	schema, ok := g.defs["ResourceType"]
	if !ok {
		return "", nil
	}
	values, ok := schema["enum"].([]any)
	if !ok || len(values) == 0 {
		return "", fmt.Errorf("ResourceType schema must define a non-empty enum")
	}
	literals := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			return "", fmt.Errorf("ResourceType enum value %v is not a string", value)
		}
		literals = append(literals, jsonString(text))
	}
	return "export const RESOURCE_TYPE_VALUES = [" + strings.Join(literals, ", ") + "] as const satisfies readonly ResourceType[];\n\n", nil
}
