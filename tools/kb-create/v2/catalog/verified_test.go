package catalog

import (
	"path/filepath"
	"testing"
)

// case: S-284.20
func TestVerifiedCatalogRejectsChangesAndDoesNotExposeMutableProvenance(t *testing.T) {
	source, err := LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	source.Provenance[0].Version = "1.2.3"
	if _, err := VerifyCatalog(source); err == nil {
		t.Fatal("tampered release accepted")
	}
	first, err := verified.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	first.Provenance[0].Version = "1.2.3"
	second, err := verified.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if second.Provenance[0].Version == "1.2.3" {
		t.Fatal("verified provenance was mutable")
	}
	if _, err := (Verified{}).Catalog(); err == nil {
		t.Fatal("zero verified catalog accepted")
	}
}
