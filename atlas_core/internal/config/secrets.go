package config

import (
	"fmt"
	"os"
	"strings"
)

func loadMinIOSecretKey() (string, error) {
	if key := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY")); key != "" {
		return key, nil
	}
	if keyFile := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY_FILE")); keyFile != "" {
		// #nosec G304 G703 -- path comes from operator env (MINIO_SECRET_KEY_FILE), not request input.
		data, err := os.ReadFile(keyFile)
		if err != nil {
			return "", fmt.Errorf("read MINIO_SECRET_KEY_FILE %s: %w", keyFile, err)
		}
		key := strings.TrimSpace(string(data))
		if key == "" {
			return "", fmt.Errorf("MINIO_SECRET_KEY_FILE %s is empty", keyFile)
		}
		return key, nil
	}
	return "", nil
}
