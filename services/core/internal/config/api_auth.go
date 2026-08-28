package config

import (
	"fmt"
	"strings"
)

const (
	minAPIAuthKeySequenceLength = 6
	minAPIAuthKeyUniqueRunes    = 4
)

var weakAPIAuthKeySubstrings = []string{"admin", "asdf", "letmein", "password", "qwerty", "welcome"}

func validateAPIAuthKey(enabled bool, key string) (string, error) {
	key = strings.TrimSpace(key)
	if !enabled {
		return key, nil
	}
	if key == "" {
		return "", fmt.Errorf("ENABLE_API_AUTH is true but API_AUTH_KEY is empty")
	}
	placeholderKeys := map[string]struct{}{
		"000000":        {},
		"111111":        {},
		"123456":        {},
		"abcd1234":      {},
		"changeme":      {},
		"admin":         {},
		"apikey":        {},
		"asdf":          {},
		"default":       {},
		"dummy":         {},
		"example":       {},
		"key":           {},
		"password":      {},
		"password123":   {},
		"placeholder":   {},
		"qwerty":        {},
		"secret":        {},
		"test":          {},
		"your-key-here": {},
	}
	normalized := strings.ToLower(key)
	if _, placeholder := placeholderKeys[normalized]; placeholder || isWeakAPIAuthKey(normalized) {
		return "", fmt.Errorf("API_AUTH_KEY is too weak for API auth")
	}
	return key, nil
}

func isWeakAPIAuthKey(key string) bool {
	if len(key) < 8 {
		return true
	}
	if uniqueRuneCount(key) < minAPIAuthKeyUniqueRunes {
		return true
	}
	for _, weakSubstring := range weakAPIAuthKeySubstrings {
		if strings.Contains(key, weakSubstring) {
			return true
		}
	}
	if strings.HasSuffix(key, "123") {
		return true
	}
	if hasSequence(key, minAPIAuthKeySequenceLength) {
		return true
	}
	return allSameRune(key)
}

func uniqueRuneCount(value string) int {
	seen := map[rune]struct{}{}
	for _, current := range value {
		seen[current] = struct{}{}
	}
	return len(seen)
}

func hasSequence(value string, minLength int) bool {
	if minLength <= 1 {
		return value != ""
	}
	runLength := 1
	lastStep := 0
	var previous rune
	for index, current := range value {
		if index == 0 {
			previous = current
			continue
		}
		step := sequenceStep(previous, current)
		if step != 0 && step == lastStep {
			runLength++
		} else if step != 0 {
			runLength = 2
			lastStep = step
		} else {
			runLength = 1
			lastStep = 0
		}
		if runLength >= minLength {
			return true
		}
		previous = current
	}
	return false
}

func sequenceStep(previous, current rune) int {
	if !sameSequenceClass(previous, current) {
		return 0
	}
	switch current {
	case previous + 1:
		return 1
	case previous - 1:
		return -1
	default:
		return 0
	}
}

func sameSequenceClass(left, right rune) bool {
	return (left >= '0' && left <= '9' && right >= '0' && right <= '9') ||
		(left >= 'a' && left <= 'z' && right >= 'a' && right <= 'z')
}

func allSameRune(value string) bool {
	var first rune
	for index, current := range value {
		if index == 0 {
			first = current
			continue
		}
		if current != first {
			return false
		}
	}
	return value != ""
}
