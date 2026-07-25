package handlers

import (
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func serializeCheckinTasksMinimal(tasks []*serializers.TaskResponse) []map[string]interface{} {
	minimal := make([]map[string]interface{}, 0, len(tasks))
	for _, task := range tasks {
		entry := map[string]interface{}{
			"task_id": task.TaskID,
			"status":  task.Status,
		}
		if task.EntityID != nil {
			entry["entity_id"] = *task.EntityID
		}

		commandID, parameters := extractCheckinTaskFields(task.Components)
		if commandID != "" {
			entry["command_id"] = commandID
		}
		if parameters != nil {
			entry["parameters"] = parameters
		}

		minimal = append(minimal, entry)
	}
	return minimal
}

// extractCheckinTaskFields returns compact task fields for entity check-ins.
// command_id priority is command.id, then command.type.
// parameters priority is top-level parameters, top-level target, command.parameters, then command.target.
func extractCheckinTaskFields(components map[string]interface{}) (string, map[string]interface{}) {
	if components == nil {
		return "", nil
	}

	commandID := ""
	parameters := firstMap(components["parameters"], components["target"])
	if command, ok := components["command"].(map[string]interface{}); ok {
		commandID = firstNonEmptyString(command["id"], command["type"])
		if parameters == nil {
			parameters = firstMap(command["parameters"], command["target"])
		}
	}

	return commandID, parameters
}

func firstNonEmptyString(values ...interface{}) string {
	for _, value := range values {
		if s, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func firstMap(values ...interface{}) map[string]interface{} {
	for _, value := range values {
		if m, ok := value.(map[string]interface{}); ok {
			return m
		}
	}
	return nil
}
