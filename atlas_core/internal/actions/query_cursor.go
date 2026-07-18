package actions

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// rowCursor is an opaque pagination token: last row's sort key (time + id), optional
// snapshot time upper bound, and optional full-dataset change-version watermark.
type rowCursor struct {
	TS string `json:"ts"` // RFC3339Nano UTC
	ID string `json:"id"`
	UB string `json:"ub,omitempty"` // upper bound snapshot time (RFC3339Nano UTC)
	UV int64  `json:"uv,omitempty"` // full-dataset change-version watermark
}

type versionCursor struct {
	V  int64  `json:"v"`
	ID string `json:"id"`
	UV int64  `json:"uv"` // upper bound snapshot version
	SV *int64 `json:"sv"` // original since_version; pointer distinguishes missing from valid zero
}

// encodeRowCursor returns a URL-safe opaque string for (t, id) using descending sort
// (created_at/updated_at/deleted_at, resource id). When upperBound is non-zero it is
// embedded so later pages cap rows to the same snapshot.
func encodeRowCursor(t time.Time, id string, upperBound time.Time) (string, error) {
	return encodeRowCursorPayload(t, id, upperBound, 0)
}

func encodeFullDatasetCursor(t time.Time, id string, upperBound time.Time, upperVersion int64) (string, error) {
	if upperBound.IsZero() {
		return "", fmt.Errorf("marshal full dataset cursor: snapshot time must be present")
	}
	if upperVersion <= 0 {
		return "", fmt.Errorf("marshal full dataset cursor: snapshot version must be positive")
	}
	return encodeRowCursorPayload(t, id, upperBound, upperVersion)
}

func encodeRowCursorPayload(t time.Time, id string, upperBound time.Time, upperVersion int64) (string, error) {
	if id == "" {
		return "", fmt.Errorf("marshal row cursor: empty id")
	}
	p := rowCursor{
		TS: t.UTC().Format(time.RFC3339Nano),
		ID: id,
		UV: upperVersion,
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

// decodeRowCursor parses encodeRowCursor output. upperBound is zero when absent (legacy cursors).
func decodeRowCursor(s string) (time.Time, string, time.Time, error) {
	p, timestamp, upperBound, err := decodeRowCursorPayload(s)
	if err != nil {
		return time.Time{}, "", time.Time{}, err
	}
	return timestamp, p.ID, upperBound, nil
}

func decodeFullDatasetCursor(s string) (time.Time, string, time.Time, int64, error) {
	p, timestamp, upperBound, err := decodeRowCursorPayload(s)
	if err != nil {
		return time.Time{}, "", time.Time{}, 0, err
	}
	if upperBound.IsZero() {
		return time.Time{}, "", time.Time{}, 0, fmt.Errorf("cursor missing snapshot time")
	}
	if p.UV <= 0 {
		return time.Time{}, "", time.Time{}, 0, fmt.Errorf("cursor missing snapshot version")
	}
	return timestamp, p.ID, upperBound, p.UV, nil
}

func decodeRowCursorPayload(s string) (rowCursor, time.Time, time.Time, error) {
	if s == "" {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("empty cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("decode cursor: %w", err)
	}
	var p rowCursor
	if err := json.Unmarshal(raw, &p); err != nil {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("parse cursor json: %w", err)
	}
	if p.ID == "" {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("cursor missing id")
	}
	tt, err := parseRFC3339WithNanoOrFallback(p.TS)
	if err != nil {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("parse cursor time: %w", err)
	}
	var upperBound time.Time
	if p.UB != "" {
		upperBound, err = parseRFC3339WithNanoOrFallback(p.UB)
		if err != nil {
			return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("parse cursor upper bound: %w", err)
		}
	}
	if p.UV < 0 {
		return rowCursor{}, time.Time{}, time.Time{}, fmt.Errorf("cursor snapshot version must be non-negative")
	}
	return p, tt, upperBound, nil
}

func encodeVersionCursor(version int64, id string, upperBound int64, sinceVersion int64) (string, error) {
	if version <= 0 {
		return "", fmt.Errorf("marshal version cursor: version must be positive")
	}
	if id == "" {
		return "", fmt.Errorf("marshal version cursor: empty id")
	}
	if upperBound <= 0 {
		return "", fmt.Errorf("marshal version cursor: upper bound version must be positive")
	}
	if sinceVersion < 0 {
		return "", fmt.Errorf("marshal version cursor: since_version must be non-negative")
	}
	cursorSinceVersion := sinceVersion
	p := versionCursor{
		V:  version,
		ID: id,
		UV: upperBound,
		SV: &cursorSinceVersion,
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal version cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func decodeVersionCursor(s string) (int64, string, int64, int64, error) {
	if s == "" {
		return 0, "", 0, 0, fmt.Errorf("empty cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", 0, 0, fmt.Errorf("decode cursor: %w", err)
	}
	var p versionCursor
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0, "", 0, 0, fmt.Errorf("parse cursor json: %w", err)
	}
	if p.ID == "" {
		return 0, "", 0, 0, fmt.Errorf("cursor missing id")
	}
	if p.V <= 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor version must be positive")
	}
	if p.UV <= 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor upper bound version must be positive")
	}
	if p.SV == nil {
		return 0, "", 0, 0, fmt.Errorf("cursor missing since_version")
	}
	if *p.SV < 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor since_version must be non-negative")
	}
	return p.V, p.ID, p.UV, *p.SV, nil
}
