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
			wantSub:  []string{`attachment`},
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
			if tt.filename == "résumé.pdf" && !strings.Contains(strings.ToLower(got), `filename*=utf-8''`) {
				t.Fatalf("attachmentContentDisposition(%q) = %q, want RFC 5987 filename* with UTF-8 charset", tt.filename, got)
			}
		})
	}
}
