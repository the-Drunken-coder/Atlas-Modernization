package artifacts

import (
	"fmt"
	"go/format"
)

func formatGeneratedGoSource(source string) ([]byte, error) {
	formatted, err := format.Source([]byte(source))
	if err != nil {
		return nil, fmt.Errorf("format generated Go source: %w", err)
	}
	return formatted, nil
}
