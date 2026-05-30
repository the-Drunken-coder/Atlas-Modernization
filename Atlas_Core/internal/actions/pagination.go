package actions

const (
	DefaultListLimit = 100
	MaxListLimit     = 500
)

// ClampListLimit returns the effective page size for standard list endpoints (default 100, max 500).
func ClampListLimit(limit int) int {
	return ClampLimit(limit, DefaultListLimit, MaxListLimit)
}

// ClampLimit clamps limit to [defaultLimit, maxLimit], using defaultLimit when limit <= 0.
func ClampLimit(limit, defaultLimit, maxLimit int) int {
	if limit <= 0 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}
