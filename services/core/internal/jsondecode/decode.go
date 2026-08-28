// Package jsondecode provides strict JSON decoding that rejects trailing values.
package jsondecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ErrTrailingData is returned when additional JSON values follow the first decoded value.
var ErrTrailingData = errors.New("unexpected trailing JSON data")

// Decode decodes a single JSON value into v and rejects any trailing data in the stream.
func Decode(dec *json.Decoder, v any) error {
	if err := dec.Decode(v); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	if len(bytes.TrimSpace(trailing)) > 0 {
		return ErrTrailingData
	}
	return nil
}
