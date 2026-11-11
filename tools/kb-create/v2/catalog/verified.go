package catalog

import (
	"encoding/json"
	"fmt"
)

// Verified owns an immutable serialized copy of an index whose seal was checked.
// Its zero value does not represent a verified release.
type Verified struct {
	data string
}

// VerifyCatalog verifies and snapshots a release index at a trust boundary.
func VerifyCatalog(source Catalog) (Verified, error) {
	data, err := json.Marshal(source)
	if err != nil {
		return Verified{}, err
	}
	var snapshot Catalog
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return Verified{}, err
	}
	if err := Verify(snapshot); err != nil {
		return Verified{}, err
	}
	return Verified{data: string(data)}, nil
}

// Catalog returns an independent copy and rechecks its seal before use.
func (verified Verified) Catalog() (Catalog, error) {
	if verified.data == "" {
		return Catalog{}, fmt.Errorf("verified release index is required")
	}
	var source Catalog
	if err := json.Unmarshal([]byte(verified.data), &source); err != nil {
		return Catalog{}, err
	}
	if err := Verify(source); err != nil {
		return Catalog{}, err
	}
	return source, nil
}

// DecodeVerified verifies an index transported in a plan or receipt.
func DecodeVerified(data []byte) (Verified, error) {
	var source Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		return Verified{}, fmt.Errorf("decode release index: %w", err)
	}
	return VerifyCatalog(source)
}
