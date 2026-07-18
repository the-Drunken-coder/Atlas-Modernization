package config

import (
	"fmt"
	"net/netip"
	"strings"
)

func parseTrustedProxyCIDRs(raw string) ([]netip.Prefix, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []netip.Prefix{}, nil
	}

	values := strings.Split(raw, ",")
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXY_CIDRS contains invalid CIDR %q", value)
		}
		if prefix.Addr().Is4In6() {
			return nil, fmt.Errorf("TRUSTED_PROXY_CIDRS must use IPv4 notation instead of %q", value)
		}
		if prefix.Bits() != prefix.Addr().BitLen() {
			return nil, fmt.Errorf("TRUSTED_PROXY_CIDRS must contain exact /32 or /128 peers, got %q", value)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}
