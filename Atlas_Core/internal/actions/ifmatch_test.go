package actions

import (
	"testing"
)

func TestParseIfMatchExpectedVersion(t *testing.T) {
	expected, err := ParseIfMatchExpectedVersion(`"v42"`)
	if err != nil {
		t.Fatalf("ParseIfMatchExpectedVersion() unexpected error: %v", err)
	}
	if expected == nil || *expected != 42 {
		t.Fatalf("expected version 42, got %v", expected)
	}
}

func TestParseIfMatchExpectedVersionWildcard(t *testing.T) {
	expected, err := ParseIfMatchExpectedVersion("*")
	if err != nil {
		t.Fatalf("ParseIfMatchExpectedVersion(*) unexpected error: %v", err)
	}
	if expected != nil {
		t.Fatalf("wildcard expected nil version, got %v", *expected)
	}
}

func TestParseIfMatchExpectedVersionRejectsWeak(t *testing.T) {
	if _, err := ParseIfMatchExpectedVersion(`W/"v42"`); err == nil {
		t.Fatal("expected weak If-Match token to be rejected")
	}
}

func TestParseIfMatchExpectedVersionRejectsMultipleVersions(t *testing.T) {
	if _, err := ParseIfMatchExpectedVersion(`"v41", "v42"`); err == nil {
		t.Fatal("expected multiple strong versions to be rejected")
	}
}
