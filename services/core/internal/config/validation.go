package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
	"golang.org/x/net/idna"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
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
		hostname, validHostname := canonicalPluginHostname(plugin.BaseURL, parsed)
		if parsed.Scheme != "http" || !validHostname || parsed.User != nil || strings.HasSuffix(parsed.Host, ":") || strings.ContainsAny(plugin.BaseURL, "?#") || parsed.Path != "" {
			return fmt.Errorf("plugins[%d].base_url must be a plain HTTP origin", index)
		}
		port := parsed.Port()
		if port != "" {
			value, err := strconv.ParseUint(port, 10, 16)
			if err != nil || value == 0 {
				return fmt.Errorf("plugins[%d].base_url must be a plain HTTP origin", index)
			}
		}
		if hostname != parsed.Hostname() {
			// Store the lookup A-label so Go cannot derive different DNS and Host names.
			parsed.Host = hostname
			if port != "" {
				parsed.Host = net.JoinHostPort(hostname, port)
			}
			plugin.BaseURL = parsed.String()
		}
	}
	return nil
}

// canonicalPluginHostname rejects names that DNS cannot resolve or that IDNA
// would silently remap, and returns the request-safe A-label when needed.
func canonicalPluginHostname(baseURL string, parsed *url.URL) (string, bool) {
	hostname := parsed.Hostname()
	if hostname == "" {
		return "", false
	}
	if strings.HasPrefix(parsed.Host, "[") {
		return hostname, true
	}
	if strings.Contains(baseURL, "%") {
		return "", false
	}
	if strings.IndexFunc(hostname, func(r rune) bool {
		return r != '.' && (r < '0' || r > '9')
	}) == -1 && net.ParseIP(hostname) == nil {
		return "", false
	}

	rooted := strings.HasSuffix(hostname, ".")
	hostname = strings.TrimSuffix(hostname, ".")
	labels := strings.Split(hostname, ".")
	canonical := make([]string, 0, len(labels))
	for _, label := range labels {
		if label == "" || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", false
		}
		if strings.HasPrefix(strings.ToLower(label), "xn--") {
			if _, err := idna.Lookup.ToUnicode(label); err != nil {
				return "", false
			}
		}
		if strings.IndexFunc(label, func(r rune) bool { return r > unicode.MaxASCII }) == -1 {
			if len(label) > 63 || strings.IndexFunc(label, func(r rune) bool {
				return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') &&
					(r < '0' || r > '9') && r != '-' && r != '_'
			}) != -1 {
				return "", false
			}
			canonical = append(canonical, label)
			continue
		}

		normalized, _ := pluginHostnameLiteral.ToUnicode(label)
		if normalized != label {
			return "", false
		}
		// UTS #46 lowercasing includes multi-code-point mappings such as U+0130 to i + U+0307.
		lowerLabel := cases.Lower(language.Und, cases.HandleFinalSigma(false)).String(label)
		lowerNormalized, err := pluginHostnameLiteral.ToUnicode(lowerLabel)
		if err != nil || lowerNormalized != lowerLabel {
			return "", false
		}
		runes := []rune(label)
		if len(runes) > 3 && runes[2] == '-' && runes[3] == '-' {
			return "", false
		}
		if _, err := idna.Lookup.ToASCII(label); err != nil {
			return "", false
		}
		lookup, lookupErr := pluginHostnameLookup.ToASCII(label)
		literal, literalErr := pluginHostnameLiteral.ToASCII(lowerLabel)
		if lookupErr != nil || literalErr != nil || lookup != literal {
			return "", false
		}
		canonical = append(canonical, lookup)
	}

	hostname = strings.Join(canonical, ".")
	if len(hostname) > 253 {
		return "", false
	}
	if rooted {
		hostname += "."
	}
	return hostname, true
}
