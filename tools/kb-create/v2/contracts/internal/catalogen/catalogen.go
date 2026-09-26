// Package catalogen renders codes_gen.go from errors.catalog.json.
package catalogen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"sort"
)

// CatalogPath is the catalog of record, relative to the contracts package.
const CatalogPath = "../../../../core/platform/src/error-envelope/errors.catalog.json"

type entry struct {
	Code      string `json:"code"`
	Area      string `json:"area"`
	Stage     string `json:"stage"`
	Retryable bool   `json:"retryable"`
}

// Render turns the catalog JSON into the formatted Go source of codes_gen.go.
func Render(catalog []byte) ([]byte, error) {
	var parsed struct {
		Codes []entry `json:"codes"`
	}
	if err := json.Unmarshal(catalog, &parsed); err != nil {
		return nil, fmt.Errorf("decode catalog: %w", err)
	}
	sort.Slice(parsed.Codes, func(i, j int) bool { return parsed.Codes[i].Code < parsed.Codes[j].Code })
	var out bytes.Buffer
	out.WriteString("// Code generated from core/platform/src/error-envelope/errors.catalog.json; DO NOT EDIT.\n\npackage contracts\n\n")
	out.WriteString("var launcherCodes = map[string]CodeInfo{\n")
	for _, item := range parsed.Codes {
		fmt.Fprintf(&out, "\t%q: {Area: ErrorArea(%q), Stage: ErrorStage(%q), Retryable: %t},\n", item.Code, item.Area, item.Stage, item.Retryable)
	}
	out.WriteString("}\n")
	return format.Source(out.Bytes())
}
