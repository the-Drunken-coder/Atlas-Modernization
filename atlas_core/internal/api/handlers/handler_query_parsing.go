package handlers

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func parseNonNegativeIntQuery(r *http.Request, key string, defaultVal int) (int, error) {
	s := strings.TrimSpace(r.URL.Query().Get(key))
	if s == "" {
		return defaultVal, nil
	}
	i, err := strconv.Atoi(s)
	if err != nil || i < 0 {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return i, nil
}

func parseNonNegativeInt64Query(r *http.Request, key string, defaultVal int64) (int64, error) {
	s := strings.TrimSpace(r.URL.Query().Get(key))
	if s == "" {
		return defaultVal, nil
	}
	i, err := strconv.ParseInt(s, 10, 64)
	if err != nil || i < 0 {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return i, nil
}

func parseStatusFilter(filter string) []string {
	rawStatuses := strings.Split(filter, ",")
	result := make([]string, 0, len(rawStatuses))
	seen := make(map[string]struct{}, len(rawStatuses))
	for _, raw := range rawStatuses {
		normalized := strings.ToLower(strings.TrimSpace(raw))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func parseRFC3339Timestamp(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339Nano, raw)
}

func optionalQueryString(q url.Values, key string) *string {
	v := strings.TrimSpace(q.Get(key))
	if v == "" {
		return nil
	}
	return &v
}

// parseListPagination reads limit and cursor query params; writes a 400 response and returns ok=false on error.
// The returned limit is already clamped to the standard list bounds (see actions.ClampListLimit),
// so callers can use it directly for both the query and pagination headers.
func (h *Handler) parseListPagination(w http.ResponseWriter, r *http.Request) (limit int, cursor string, ok bool) {
	if _, exists := r.URL.Query()["offset"]; exists {
		h.writeError(w, r, http.StatusBadRequest, "offset pagination is not supported; use cursor", protocol.ErrorCodeValidationError)
		return 0, "", false
	}
	limit, err := parseNonNegativeIntQuery(r, "limit", 100)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit parameter", protocol.ErrorCodeValidationError)
		return 0, "", false
	}
	return actions.ClampListLimit(limit), strings.TrimSpace(r.URL.Query().Get("cursor")), true
}

func parseFullDatasetLimits(r *http.Request) (*actions.FullDatasetLimits, string, error) {
	el, err := parseNonNegativeIntQuery(r, "entity_limit", 0)
	if err != nil {
		return nil, "entity_limit", err
	}
	tl, err := parseNonNegativeIntQuery(r, "task_limit", 0)
	if err != nil {
		return nil, "task_limit", err
	}
	ol, err := parseNonNegativeIntQuery(r, "object_limit", 0)
	if err != nil {
		return nil, "object_limit", err
	}
	q := r.URL.Query()
	return &actions.FullDatasetLimits{
		EntityLimit:  el,
		TaskLimit:    tl,
		ObjectLimit:  ol,
		EntityCursor: optionalQueryString(q, "entity_cursor"),
		TaskCursor:   optionalQueryString(q, "task_cursor"),
		ObjectCursor: optionalQueryString(q, "object_cursor"),
	}, "", nil
}

func changedSinceCursorsFromQuery(q url.Values) actions.ChangedSinceCursors {
	return actions.ChangedSinceCursors{
		EntityCursor:        optionalQueryString(q, "entity_cursor"),
		TaskCursor:          optionalQueryString(q, "task_cursor"),
		ObjectCursor:        optionalQueryString(q, "object_cursor"),
		DeletedEntityCursor: optionalQueryString(q, "deleted_entity_cursor"),
		DeletedTaskCursor:   optionalQueryString(q, "deleted_task_cursor"),
		DeletedObjectCursor: optionalQueryString(q, "deleted_object_cursor"),
	}
}
