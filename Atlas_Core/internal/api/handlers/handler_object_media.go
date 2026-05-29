package handlers

import (
	"mime"
	"strings"
)

// isViewableContentType checks if a content type can be safely displayed inline in a browser or API response.
func isViewableContentType(contentType string) bool {
	viewableTypes := []string{
		"text/plain",
		"text/css",
		"text/xml",
		"text/csv",
		"text/markdown",
		"application/json",
		"application/xml",
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
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}
