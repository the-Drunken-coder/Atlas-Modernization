package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxPluginEndpointFragmentBytes = 64 << 10

func (c *Config) loadPluginEndpointFragments(directory string) error {
	c.Plugins = nil
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return fmt.Errorf("open plugin endpoint configuration directory: %w", err)
	}
	defer func() { _ = root.Close() }()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return fmt.Errorf("read plugin endpoint configuration directory: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
			return fmt.Errorf("plugin endpoint configuration directory contains unsupported entry %q", entry.Name())
		}
		file, err := root.Open(entry.Name())
		if err != nil {
			return fmt.Errorf("open plugin endpoint fragment %s: %w", entry.Name(), err)
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxPluginEndpointFragmentBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return fmt.Errorf("read plugin endpoint fragment %s: %w", entry.Name(), readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close plugin endpoint fragment %s: %w", entry.Name(), closeErr)
		}
		if len(data) == 0 || len(data) > maxPluginEndpointFragmentBytes {
			return fmt.Errorf("plugin endpoint fragment %s must contain 1 to %d bytes", entry.Name(), maxPluginEndpointFragmentBytes)
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		var endpoint PluginConfig
		if err := decoder.Decode(&endpoint); err != nil {
			return fmt.Errorf("decode plugin endpoint fragment %s: %w", entry.Name(), err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return fmt.Errorf("plugin endpoint fragment %s contains trailing JSON", entry.Name())
		}
		c.Plugins = append(c.Plugins, endpoint)
	}
	return nil
}
