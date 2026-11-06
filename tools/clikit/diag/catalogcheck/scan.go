// Package catalogcheck scans Go sources for diagnostic code literals.
package catalogcheck

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var kbCodeLiteral = regexp.MustCompile(`^KB_[A-Z0-9_]+$`)

type SourceScan struct {
	Files []string
	Codes map[string][]string
}

func Scan(sourceRoot string, environmentVariables []string) (SourceScan, error) {
	scan := SourceScan{Codes: make(map[string][]string)}
	environmentNames := make(map[string]struct{}, len(environmentVariables))
	for _, name := range environmentVariables {
		environmentNames[name] = struct{}{}
	}
	err := filepath.WalkDir(sourceRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != sourceRoot && (entry.Name() == "e2e" || entry.Name() == "vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || filepath.Base(path) == "catalog_gen.go" {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		source := filepath.Clean(path)
		scan.Files = append(scan.Files, source)
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING || isMapIndexKey(file, literal) {
				return true
			}
			code, err := strconv.Unquote(literal.Value)
			if err != nil || !kbCodeLiteral.MatchString(code) {
				return true
			}
			if _, envName := environmentNames[code]; !envName {
				scan.Codes[code] = append(scan.Codes[code], source)
			}
			return true
		})
		return nil
	})
	return scan, err
}

func Uncatalogued(codes map[string][]string, entries map[string]struct{}) map[string][]string {
	missing := make(map[string][]string)
	for code, locations := range codes {
		if _, ok := entries[code]; !ok {
			missing[code] = locations
		}
	}
	return missing
}

func isMapIndexKey(file *ast.File, target *ast.BasicLit) bool {
	found := false
	ast.Inspect(file, func(node ast.Node) bool {
		index, ok := node.(*ast.IndexExpr)
		if ok && index.Index == target {
			found = true
			return false
		}
		return !found
	})
	return found
}
