package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

func (c *Config) validate() error {
	if err := validateCORSOrigins(c.CORSOrigins); err != nil {
		return err
	}
	if err := validateCORSOriginPatterns(c.CORSOriginPatterns); err != nil {
		return err
	}
	if err := c.validatePlugins(); err != nil {
		return err
	}

	c.AdminCookieSameSite = strings.ToLower(strings.TrimSpace(c.AdminCookieSameSite))
	if c.AdminCookieSameSite == "" {
		c.AdminCookieSameSite = "none"
	}
	switch c.AdminCookieSameSite {
	case "lax", "none", "strict":
	default:
		return fmt.Errorf("ATLAS_ADMIN_COOKIE_SAMESITE must be lax, none, or strict")
	}

	var err error
	c.APIAuthKey, err = validateAPIAuthKey(c.EnableAPIAuth, c.APIAuthKey)
	return err
}

func (c *Config) validatePlugins() error {
	seen := make(map[string]struct{}, len(c.Plugins))
	for index := range c.Plugins {
		plugin := &c.Plugins[index]
		plugin.ID = strings.TrimSpace(plugin.ID)
		if !pluginid.Valid(plugin.ID) {
			return fmt.Errorf("plugins[%d].id must match ^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$", index)
		}
		if _, duplicate := seen[plugin.ID]; duplicate {
			return fmt.Errorf("plugin ID %q is configured more than once", plugin.ID)
		}
		seen[plugin.ID] = struct{}{}

		plugin.BaseURL = strings.TrimRight(strings.TrimSpace(plugin.BaseURL), "/")
		parsed, err := url.Parse(plugin.BaseURL)
		if err != nil {
			return fmt.Errorf("plugins[%d].base_url must be a plain HTTP origin", index)
		}
		hostname := parsed.Hostname()
		invalidHostname := strings.ContainsAny(hostname, "[]<>\"") || (!strings.HasPrefix(parsed.Host, "[") && strings.Contains(hostname, ":"))
		if parsed.Scheme != "http" || hostname == "" || invalidHostname || parsed.User != nil || strings.HasSuffix(parsed.Host, ":") || strings.ContainsAny(plugin.BaseURL, "?#") || parsed.Path != "" {
			return fmt.Errorf("plugins[%d].base_url must be a plain HTTP origin", index)
		}
		if port := parsed.Port(); port != "" {
			value, err := strconv.ParseUint(port, 10, 16)
			if err != nil || value == 0 {
				return fmt.Errorf("plugins[%d].base_url must be a plain HTTP origin", index)
			}
		}
	}
	return nil
}
