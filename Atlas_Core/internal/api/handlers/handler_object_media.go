package handlers

import (
	"fmt"
	"mime"
	"net/url"
	"strings"
)

// isViewableContentType checks if a content type can be safely displayed inline in a browser or API response.
func isViewableContentType(contentType string) bool {
	viewableTypes := []string{
		"text/plain",
		"text/css",
		"text/csv",
		"text/markdown",
		"application/json",
		"application/ld+json",
	}

	// Check exact match or prefix (e.g., "text/plain; charset=utf-8" should match "text/plain")
	for _, viewable := range viewableTypes {
		if contentType == viewable || strings.HasPrefix(contentType, viewable+";") {
			return true
		}
	}
	return false
}

// getExtensionForContentType returns a file extension (including the dot) for a given MIME type.
// Falls back to common mappings if the standard library doesn't have a mapping.
func getExtensionForContentType(contentType string) string {
	// Try standard library first
	exts, err := mime.ExtensionsByType(contentType)
	if err == nil && len(exts) > 0 {
		return exts[0]
	}

	// Fallback mappings for common types
	fallbacks := map[string]string{
		"text/plain":                      ".txt",
		"text/html":                       ".html",
		"text/css":                        ".css",
		"text/javascript":                 ".js",
		"application/json":                ".json",
		"application/xml":                 ".xml",
		"application/pdf":                 ".pdf",
		"application/zip":                 ".zip",
		"application/gzip":                ".gz",
		"application/octet-stream":        "",
		"image/jpeg":                      ".jpg",
		"image/png":                       ".png",
		"image/gif":                       ".gif",
		"image/webp":                      ".webp",
		"image/svg+xml":                   ".svg",
		"image/tiff":                      ".tif",
		"image/tiff; application=geotiff": ".tif",
		"video/mp4":                       ".mp4",
		"video/webm":                      ".webm",
		"audio/mpeg":                      ".mp3",
		"audio/wav":                       ".wav",
		// LiDAR/Geospatial formats
		"application/x-laz":       ".laz",
		"application/x-las":       ".las",
		"application/vnd.las":     ".las",
		"application/vnd.las+laz": ".laz",
		"image/vnd.tiff":          ".tif",
	}

	if ext, ok := fallbacks[contentType]; ok {
		return ext
	}

	return ""
}

// attachmentContentDisposition builds an RFC 6266 Content-Disposition value for downloads.
func attachmentContentDisposition(filename string) string {
	if filename == "" {
		return "attachment"
	}
	if cd := mime.FormatMediaType("attachment", map[string]string{"filename": filename}); cd != "" {
		return cd
	}

	legacy := escapeRFC6266QuotedString(asciiFilenameFallback(filename))
	cd := fmt.Sprintf(`attachment; filename="%s"`, legacy)
	if filenameNeedsExtendedValue(filename) {
		cd += fmt.Sprintf(`; filename*=UTF-8''%s`, url.PathEscape(filename))
	}
	return cd
}

func asciiFilenameFallback(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f:
			continue
		case r > 0x7e:
			b.WriteByte('?')
		default:
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "download"
	}
	return b.String()
}

func escapeRFC6266QuotedString(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '\\' || r == '"' {
			b.WriteByte('\\')
		}
		if r >= 0x20 && r <= 0x7e {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func filenameNeedsExtendedValue(name string) bool {
	for _, r := range name {
		if r > 0x7e || r < 0x20 {
			return true
		}
	}
	return false
}
