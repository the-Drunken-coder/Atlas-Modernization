package actions

const (
	DefaultListLimit = 100
	MaxListLimit     = 500
)

// ListPage is the action-layer page result for standard cursor-paginated lists.
type ListPage[T any] struct {
	Items      []T
	Limit      int
	HasMore    bool
	NextCursor string
}

// ClampListLimit returns the effective page size for standard list endpoints (default 100, max 500).
func ClampListLimit(limit int) int {
	return ClampLimit(limit, DefaultListLimit, MaxListLimit)
}

// ClampLimit returns defaultLimit when limit <= 0, caps limit at maxLimit, and otherwise returns limit unchanged.
func ClampLimit(limit, defaultLimit, maxLimit int) int {
	if limit <= 0 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}
