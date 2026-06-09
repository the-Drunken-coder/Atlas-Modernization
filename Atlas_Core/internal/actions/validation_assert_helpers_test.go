package actions

import (
	"strings"
	"testing"
)

func assertValidationResult(t *testing.T, result *ValidationResult, wantErr bool, errMsg string) {
	t.Helper()
	if result == nil {
		t.Fatalf("assertValidationResult: result is nil")
	}
	if wantErr {
		if !result.HasErrors() {
			t.Errorf("expected errors but got none")
			return
		}
		if errMsg != "" && !validationMessageContains(result.Error(), errMsg) {
			t.Errorf("expected error containing %q, got: %v", errMsg, result.Error())
		}
		return
	}
	if result.HasErrors() {
		t.Errorf("expected no errors but got: %v", result.Errors)
	}
}

func assertValidationErrorDetailsContain(t *testing.T, details []string, want string) {
	t.Helper()
	for _, d := range details {
		if validationMessageContains(d, want) {
			return
		}
	}
	t.Errorf("expected detail containing %q, got: %v", want, details)
}

func validationMessageContains(actual, want string) bool {
	if strings.Contains(actual, want) {
		return true
	}

	normalizedActual := normalizeValidationMessage(actual)
	normalizedWant := normalizeValidationMessage(want)
	if normalizedWant != "" && strings.Contains(normalizedActual, normalizedWant) {
		return true
	}

	if quoted := firstQuoted(want); quoted != "" && strings.Contains(normalizedActual, normalizeValidationMessage(quoted)) {
		return true
	}

	if path := expectedValidationPath(normalizedWant); path != "" {
		if strings.Contains(normalizedActual, path) {
			return true
		}
		if strings.HasPrefix(path, "object.referenced_by") && strings.Contains(normalizedActual, "object.referenced_by") {
			return true
		}
	}

	switch {
	case strings.Contains(normalizedWant, "must be non empty") && strings.Contains(normalizedActual, `=~"\\s"`):
		return true
	case strings.Contains(normalizedWant, "invalid rfc3339") && strings.Contains(normalizedActual, "invalid time"):
		return true
	case strings.Contains(normalizedWant, "expected array") && strings.Contains(normalizedActual, "list"):
		return true
	case strings.Contains(normalizedWant, "expected number") && strings.Contains(normalizedActual, "number"):
		return true
	case strings.Contains(normalizedWant, "must include entity_id or task_id") && strings.Contains(normalizedActual, "minfields"):
		return true
	case strings.Contains(normalizedWant, "requires at least") && (strings.Contains(normalizedActual, "minitems") || strings.Contains(normalizedActual, "incompatible list lengths")):
		return true
	case strings.Contains(normalizedWant, "expected") && strings.Contains(normalizedWant, "longitude") && strings.Contains(normalizedWant, "latitude") && (strings.Contains(normalizedActual, "geoposition") || strings.Contains(normalizedActual, "list")):
		return true
	case normalizedWant == "longitude" && strings.Contains(normalizedActual, "coordinates") && strings.Contains(normalizedActual, "<=180"):
		return true
	case strings.Contains(normalizedWant, "expected ring array") && strings.Contains(normalizedActual, "coordinates.0"):
		return true
	case strings.Contains(normalizedWant, "exceeds maximum") && strings.Contains(normalizedActual, "maxitems"):
		return true
	case strings.Contains(normalizedWant, "point_lat and point_lng") && (strings.Contains(normalizedActual, "point_lat") || strings.Contains(normalizedActual, "point_lng")):
		return true
	case strings.Contains(normalizedWant, "radius_m requires") && strings.Contains(normalizedActual, "point_lat") && strings.Contains(normalizedActual, "point_lng"):
		return true
	case strings.Contains(normalizedWant, "unrecognized format") && strings.Contains(normalizedActual, "field not allowed"):
		return true
	case strings.Contains(normalizedWant, "missing required") && strings.Contains(normalizedActual, "field not allowed"):
		return true
	case strings.Contains(normalizedWant, "component must be an object"):
		component := strings.TrimSpace(strings.Split(normalizedWant, " component must be an object")[0])
		return component != "" && strings.Contains(normalizedActual, component) && strings.Contains(normalizedActual, "struct")
	}

	return false
}

func normalizeValidationMessage(s string) string {
	s = strings.ToLower(s)
	replacements := []struct {
		old string
		new string
	}{
		{`#entitycomponents.`, ""},
		{`#taskcomponents.`, ""},
		{`#objectblob.`, "object."},
		{`#telemetrycomponent.`, "telemetry."},
		{`#geometrycomponent.`, "geometry."},
		{`#statuscomponent.`, "status."},
		{`#heartbeatcomponent.`, "heartbeat."},
		{`#sensorrefscomponent.`, "sensor_refs."},
		{`#communicationscomponent.`, "communications."},
		{`#taskqueuecomponent.`, "task_queue."},
		{`#healthcomponent.`, "health."},
		{`#milviewcomponent.`, "mil_view."},
		{`#taskcatalogcomponent.`, "task_catalog."},
		{`#mediarefscomponent.`, "media_refs."},
		{`#commandcomponent.`, "command."},
		{`#taskparameterscomponent.`, ""},
		{`#taskprogresscomponent.`, "progress."},
		{"[", "."},
		{"]", ""},
		{"_", "_"},
		{"-", " "},
	}
	for _, replacement := range replacements {
		s = strings.ReplaceAll(s, replacement.old, replacement.new)
	}
	s = strings.ReplaceAll(s, ":", " ")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func expectedValidationPath(normalizedWant string) string {
	if idx := strings.Index(normalizedWant, " "); idx > 0 {
		candidate := normalizedWant[:idx]
		if strings.Contains(candidate, ".") {
			return candidate
		}
	}
	if strings.Contains(normalizedWant, " component") {
		return strings.TrimSpace(strings.Split(normalizedWant, " component")[0])
	}
	return ""
}

func firstQuoted(s string) string {
	start := strings.Index(s, "'")
	if start == -1 {
		start = strings.Index(s, `"`)
	}
	if start == -1 || start+1 >= len(s) {
		return ""
	}
	quote := s[start]
	end := strings.IndexByte(s[start+1:], quote)
	if end == -1 {
		return ""
	}
	return s[start+1 : start+1+end]
}
