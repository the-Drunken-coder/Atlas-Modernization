package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
	"golang.org/x/net/idna"
)

var (
	pluginHostnameLookup  = idna.New(idna.MapForLookup(), idna.BidiRule(), idna.CheckHyphens(false), idna.VerifyDNSLength(true))
	pluginHostnameLiteral = idna.New(idna.ValidateLabels(true), idna.StrictDomainName(true), idna.BidiRule(), idna.CheckHyphens(false), idna.VerifyDNSLength(true))
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
		if parsed.Scheme != "http" || !validPluginHostname(plugin.BaseURL, parsed) || parsed.User != nil || strings.HasSuffix(parsed.Host, ":") || strings.ContainsAny(plugin.BaseURL, "?#") || parsed.Path != "" {
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

// validPluginHostname rejects names that DNS cannot resolve or that IDNA would
// silently map to a different hostname before dialing.
func validPluginHostname(baseURL string, parsed *url.URL) bool {
	hostname := parsed.Hostname()
	if hostname == "" {
		return false
	}
	if strings.HasPrefix(parsed.Host, "[") {
		return true
	}
	if strings.Contains(baseURL, "%") {
		return false
	}

	hostname = strings.TrimSuffix(hostname, ".")
	for _, label := range strings.Split(hostname, ".") {
		if label == "" || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		if strings.IndexFunc(label, func(r rune) bool { return r > unicode.MaxASCII }) != -1 {
			normalized, err := pluginHostnameLiteral.ToUnicode(label)
			if err != nil || normalized != label {
				return false
			}
			runes := []rune(label)
			if len(runes) > 3 && runes[2] == '-' && runes[3] == '-' {
				return false
			}
		}
	}
	lookup, lookupErr := pluginHostnameLookup.ToASCII(hostname)
	literal, literalErr := pluginHostnameLiteral.ToASCII(strings.ToLower(hostname))
	if lookupErr != nil || literalErr != nil || lookup != literal {
		return false
	}
	for _, label := range strings.Split(lookup, ".") {
		if label == "" || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
	}
	return true
}
