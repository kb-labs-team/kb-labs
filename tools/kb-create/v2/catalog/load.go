package catalog

import (
	"encoding/json"
	"fmt"
	"os"
)

// LoadFile reads the immutable release index selected before any artifact
// install. It is deliberately a file input: registry discovery belongs to the
// release publisher, while CI/agents need a reviewable exact index.
func LoadFile(path string) (Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Catalog{}, fmt.Errorf("read release index: %w", err)
	}
	return Decode(data)
}

// Decode parses and verifies a release index. The schema gate runs first, so
// an index of an unsupported shape is rejected before anything else reads it.
func Decode(data []byte) (Catalog, error) {
	schema, err := peekSchema(data)
	if err != nil {
		return Catalog{}, wrapIndexError("decode release index", err)
	}
	if err := CheckSchema(schema); err != nil {
		return Catalog{}, err
	}
	var result Catalog
	if err := json.Unmarshal(data, &result); err != nil {
		return Catalog{}, wrapIndexError("decode release index", err)
	}
	if err := Verify(result); err != nil {
		return Catalog{}, wrapIndexError("validate release index", err)
	}
	if result.Compatibility == nil {
		return Catalog{}, wrapIndexError("validate release index", fmt.Errorf("compatibility matrix is required"))
	}
	return result, nil
}
