package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("read Plugin endpoint configuration directory: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
			return fmt.Errorf("Plugin endpoint configuration directory contains unsupported entry %q", entry.Name())
		}
		path := filepath.Join(directory, entry.Name())
		// #nosec G304 -- the deployment operator supplies the private fragment directory.
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read Plugin endpoint fragment %s: %w", entry.Name(), err)
		}
		if len(data) == 0 || len(data) > maxPluginEndpointFragmentBytes {
			return fmt.Errorf("Plugin endpoint fragment %s must contain 1 to %d bytes", entry.Name(), maxPluginEndpointFragmentBytes)
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		var endpoint PluginConfig
		if err := decoder.Decode(&endpoint); err != nil {
			return fmt.Errorf("decode Plugin endpoint fragment %s: %w", entry.Name(), err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return fmt.Errorf("Plugin endpoint fragment %s contains trailing JSON", entry.Name())
		}
		c.Plugins = append(c.Plugins, endpoint)
	}
	return nil
}
