package actions

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// rowCursor is an opaque pagination token: last row's sort key (time + id) and optional
// snapshot upper bound (RFC3339Nano UTC) so continuation pages use the same DB snapshot.
type rowCursor struct {
	TS string `json:"ts"` // RFC3339Nano UTC
	ID string `json:"id"`
	UB string `json:"ub,omitempty"` // upper bound snapshot time (RFC3339Nano UTC)
}

// encodeRowCursor returns a URL-safe opaque string for (t, id) using descending sort
// (created_at/updated_at/deleted_at, resource id). When upperBound is non-zero it is
// embedded so later pages cap rows to the same snapshot.
func encodeRowCursor(t time.Time, id string, upperBound time.Time) (string, error) {
	if id == "" {
		return "", nil
	}
	p := rowCursor{
		TS: t.UTC().Format(time.RFC3339Nano),
		ID: id,
	}
	if !upperBound.IsZero() {
		p.UB = upperBound.UTC().Format(time.RFC3339Nano)
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal row cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// parseRFC3339WithNanoOrFallback parses RFC3339Nano with RFC3339 fallback and UTC normalization.
func parseRFC3339WithNanoOrFallback(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, fmt.Errorf("empty timestamp")
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

// parseDeletedAtCursor parses tombstone timestamps (RFC3339 or RFC3339Nano).
func parseDeletedAtCursor(s string) (time.Time, error) {
	return parseRFC3339WithNanoOrFallback(s)
}

// decodeRowCursor parses encodeRowCursor output. upperBound is zero when absent (legacy cursors).
func decodeRowCursor(s string) (time.Time, string, time.Time, error) {
	if s == "" {
		return time.Time{}, "", time.Time{}, fmt.Errorf("empty cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", time.Time{}, fmt.Errorf("decode cursor: %w", err)
	}
	var p rowCursor
	if err := json.Unmarshal(raw, &p); err != nil {
		return time.Time{}, "", time.Time{}, fmt.Errorf("parse cursor json: %w", err)
	}
	if p.ID == "" {
		return time.Time{}, "", time.Time{}, fmt.Errorf("cursor missing id")
	}
	tt, err := parseRFC3339WithNanoOrFallback(p.TS)
	if err != nil {
		return time.Time{}, "", time.Time{}, fmt.Errorf("parse cursor time: %w", err)
	}
	var upperBound time.Time
	if p.UB != "" {
		upperBound, err = parseRFC3339WithNanoOrFallback(p.UB)
		if err != nil {
			return time.Time{}, "", time.Time{}, fmt.Errorf("parse cursor upper bound: %w", err)
		}
	}
	return tt, p.ID, upperBound, nil
}
