package config

import "fmt"

const (
	maxUploadSizeMinMB int64 = 1
	maxUploadSizeMaxMB int64 = 10240
	maxViewSizeMinMB   int64 = 1
	maxViewSizeMaxMB   int64 = 100
)

func (c *Config) validateSizeLimits() error {
	if c.MaxUploadSizeMB < maxUploadSizeMinMB || c.MaxUploadSizeMB > maxUploadSizeMaxMB {
		return fmt.Errorf("MAX_UPLOAD_SIZE_MB/max_upload_size_mb must be between %d and %d MB (got %d)", maxUploadSizeMinMB, maxUploadSizeMaxMB, c.MaxUploadSizeMB)
	}
	if c.MaxViewSizeMB < maxViewSizeMinMB || c.MaxViewSizeMB > maxViewSizeMaxMB {
		return fmt.Errorf("MAX_VIEW_SIZE_MB/max_view_size_mb must be between %d and %d MB (got %d)", maxViewSizeMinMB, maxViewSizeMaxMB, c.MaxViewSizeMB)
	}
	return nil
}
