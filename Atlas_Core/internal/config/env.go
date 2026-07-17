package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func getEnv(key, defaultVal string) string {
	if val, ok := lookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}

func lookupEnv(key string) (string, bool) {
	return os.LookupEnv(key)
}

func getEnvBool(key string, defaultVal bool) (bool, error) {
	v, ok := lookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	switch strings.ToLower(val) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean for %s: %q", key, v)
	}
}

func getEnvInt(key string, defaultVal int) (int, error) {
	v, ok := lookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	i, err := strconv.Atoi(val)
	if err != nil {
		return 0, fmt.Errorf("invalid integer for %s: %q", key, v)
	}
	return i, nil
}

func getEnvInt64(key string, defaultVal int64) (int64, error) {
	v, ok := lookupEnv(key)
	if !ok {
		return defaultVal, nil
	}
	val := strings.TrimSpace(v)
	if val == "" {
		return defaultVal, nil
	}
	i, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid integer for %s: %q", key, v)
	}
	return i, nil
}
