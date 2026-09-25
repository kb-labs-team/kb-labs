// kb-create-release-index is the publish-time release-index sealer. It
// turns a normalized manifest export into a sealed immutable release index;
// it is not an installer and never reads a user's platform directory.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/release"
)

func main() {
	input := flag.String("input", "", "normalized V2 release-index export JSON")
	output := flag.String("output", "", "sealed immutable release-index JSON")
	manifestRoot := flag.String("manifest-root", "", "staging root containing exact V2 package manifests")
	flag.Parse()
	if err := run(*input, *output, *manifestRoot); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"ok": false, "error": contracts.NewLauncherError(contracts.CodeReleaseIndexInvalid, "could not seal V2 release index", "fix the normalized manifest export before publishing the release", err)})
		os.Exit(2)
	}
}

func run(input, output, manifestRoot string) error {
	if input == "" || output == "" || manifestRoot == "" {
		return fmt.Errorf("--input, --output and --manifest-root are required")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	var source catalog.Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		return err
	}
	source, err = release.EnrichWithManifests(source, manifestRoot)
	if err != nil {
		return fmt.Errorf("export V2 package manifests: %w", err)
	}
	// Exports intentionally omit release-controlled fields. Schema and digest
	// are assigned here, after all manifest data has been collected.
	source.Schema, source.Digest = "", ""
	sealed, err := catalog.Seal(source)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(sealed, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o750); err != nil {
		return err
	}
	temporary := output + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, output)
}
