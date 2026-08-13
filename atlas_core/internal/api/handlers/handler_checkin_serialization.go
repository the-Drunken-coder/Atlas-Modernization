package handlers

import (
	"strings"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func serializeCheckinTasksMinimal(tasks []protocol.TaskResource) []protocol.EntityCheckInMinimalTask {
	minimal := make([]protocol.EntityCheckInMinimalTask, 0, len(tasks))
	for _, task := range tasks {
		entry := protocol.EntityCheckInMinimalTask{
			TaskID: task.TaskID,
			Status: task.Status,
		}
		if task.EntityID != nil {
			entry.EntityID = *task.EntityID
		}

		commandID, parameters := extractCheckinTaskFields(task.Components)
		if commandID != "" {
			entry.CommandID = commandID
		}
		if parameters != nil {
			entry.Parameters = parameters
		}

		minimal = append(minimal, entry)
	}
	return minimal
}

// extractCheckinTaskFields returns compact task fields for entity check-ins.
// command_id priority is command.id, then command.type.
// parameters priority is top-level parameters, top-level target, command.parameters, then command.target.
func extractCheckinTaskFields(components map[string]protocol.JSONValue) (string, *protocol.JSONValue) {
	if components == nil {
		return "", nil
	}

	commandID := ""
	parameters := firstJSONValue(components, "parameters", "target")
	if command, ok := components["command"].(map[string]interface{}); ok {
		commandID = firstNonEmptyString(command["id"], command["type"])
		if parameters == nil {
			parameters = firstJSONValue(command, "parameters", "target")
		}
	}

	return commandID, parameters
}

func firstNonEmptyString(values ...any) string {
	for _, value := range values {
		if s, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func firstJSONValue(values map[string]protocol.JSONValue, keys ...string) *protocol.JSONValue {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return &value
		}
	}
	return nil
}
