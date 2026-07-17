package config

import (
	"fmt"
	"strings"
)

func (c *Config) validate() error {
	if err := validateCORSOrigins(c.CORSOrigins); err != nil {
		return err
	}
	if err := validateCORSOriginPatterns(c.CORSOriginPatterns); err != nil {
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
