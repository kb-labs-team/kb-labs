// Package install_spec owns the Marketplace command's package-spec grammar.
package install_spec

import "fmt"

// Validate accepts npm package install specs, including scoped names and the
// unscoped names used by Marketplace, without accepting arbitrary strings.
func Validate(value string) error {
	if value == "" {
		return fmt.Errorf("Marketplace install spec is empty")
	}
	parts := split(value)
	if len(parts) == 0 || len(parts) > 2 {
		return fmt.Errorf("Marketplace install spec must have one package name or one scope and package name")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || part[0] == '.' || part[0] == '_' {
			return fmt.Errorf("Marketplace install spec contains an invalid package-name segment")
		}
		for _, char := range part {
			if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.') {
				return fmt.Errorf("Marketplace install spec contains an invalid character")
			}
		}
	}
	return nil
}

func split(value string) []string {
	if value[0] == '@' {
		value = value[1:]
	}
	parts := make([]string, 0, 2)
	start := 0
	for index, char := range value {
		if char == '/' {
			parts = append(parts, value[start:index])
			start = index + 1
		}
	}
	return append(parts, value[start:])
}
