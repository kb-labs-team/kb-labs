// Command gen regenerates codes_gen.go from the shared error catalog.
// It runs through the go:generate directive in error.go.
package main

import (
	"fmt"
	"os"

	"github.com/kb-labs/create/v2/contracts/internal/catalogen"
)

func main() {
	data, err := os.ReadFile(catalogen.CatalogPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	source, err := catalogen.Render(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile("codes_gen.go", source, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
