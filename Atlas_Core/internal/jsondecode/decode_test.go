package jsondecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestDecode_singleValue(t *testing.T) {
	var v map[string]interface{}
	if err := Decode(json.NewDecoder(strings.NewReader(`{"a":1}`)), &v); err != nil {
		t.Fatalf("Decode: %v", err)
	}
}

func TestDecode_rejectsTrailingData(t *testing.T) {
	var v map[string]interface{}
	err := Decode(json.NewDecoder(strings.NewReader(`{"a":1}{"b":2}`)), &v)
	if !errors.Is(err, ErrTrailingData) {
		t.Fatalf("want ErrTrailingData, got %v", err)
	}
}

func TestDecode_emptyBody(t *testing.T) {
	var v map[string]interface{}
	if err := Decode(json.NewDecoder(bytes.NewReader(nil)), &v); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}
