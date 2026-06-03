package main

import (
	"slices"
	"testing"
)

func TestAtlasCORSOptionsDisablesCredentialsAndExposesCursorHeaders(t *testing.T) {
	origins := []string{"http://localhost:3000"}

	opts := atlasCORSOptions(origins)

	if opts.AllowCredentials {
		t.Fatal("expected CORS AllowCredentials to be false")
	}
	if len(opts.AllowedOrigins) != 1 || opts.AllowedOrigins[0] != origins[0] {
		t.Fatalf("expected allowed origins to be preserved, got %#v", opts.AllowedOrigins)
	}
	for _, header := range []string{"ETag", "X-Has-More", "X-Next-Cursor", "X-Limit", "X-Returned-Count", "Content-Length"} {
		if !slices.Contains(opts.ExposedHeaders, header) {
			t.Fatalf("expected exposed header %s in %#v", header, opts.ExposedHeaders)
		}
	}
	for _, removed := range []string{"X-Total-Count", "X-Offset"} {
		if slices.Contains(opts.ExposedHeaders, removed) {
			t.Fatalf("did not expect old pagination header %s in %#v", removed, opts.ExposedHeaders)
		}
	}
}
