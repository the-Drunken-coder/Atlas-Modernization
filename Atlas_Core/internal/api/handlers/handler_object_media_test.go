package handlers

import (
	"strings"
	"testing"
)

func TestAttachmentContentDisposition(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		wantSub  []string
	}{
		{
			name:     "ascii simple",
			filename: "report.json",
			wantSub:  []string{`attachment`, `filename=report.json`},
		},
		{
			name:     "quotes escaped",
			filename: `file"name.txt`,
			wantSub:  []string{`filename="file\"name.txt"`},
		},
		{
			name:     "non-ascii uses filename star",
			filename: "résumé.pdf",
			wantSub:  []string{`attachment`, `filename*=utf-8''`},
		},
		{
			name:     "empty filename",
			filename: "",
			wantSub:  []string{"attachment"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := attachmentContentDisposition(tt.filename)
			for _, sub := range tt.wantSub {
				if !strings.Contains(got, sub) {
					t.Fatalf("attachmentContentDisposition(%q) = %q, want substring %q", tt.filename, got, sub)
				}
			}
		})
	}
}
