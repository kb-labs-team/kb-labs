package launchrail

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
)

var ownerDirectories = [...]string{
	"tools/clikit/proc/child",
	"tools/kb-runner/internal/proc",
}

func Owners() []string { return append([]string(nil), ownerDirectories[:]...) }

type Finding struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Name string `json:"name"`
}

// Check parses all Go files in the workspace and finds process-group/session
// attributes and Job Object calls outside the launcher owner.
func Check(root string) ([]Finding, error) {
	var findings []Finding
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != root && (entry.Name() == ".git" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if isLaunchOwner(rel) {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.AllErrors)
		if err != nil {
			return fmt.Errorf("parse %s: %w", rel, err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch current := node.(type) {
			case *ast.CompositeLit:
				sysProcAttr := false
				switch typ := current.Type.(type) {
				case *ast.SelectorExpr:
					sysProcAttr = typ.Sel.Name == "SysProcAttr"
				case *ast.Ident:
					sysProcAttr = typ.Name == "SysProcAttr"
				}
				if sysProcAttr {
					for _, element := range current.Elts {
						field, ok := element.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						name, ok := field.Key.(*ast.Ident)
						if !ok || (name.Name != "Setpgid" && name.Name != "Setsid") {
							continue
						}
						pos := fset.Position(name.Pos())
						findings = append(findings, Finding{File: rel, Line: pos.Line, Name: name.Name})
					}
				}
			case *ast.SelectorExpr:
				if current.Sel.Name == "Setpgid" || current.Sel.Name == "Setsid" {
					pos := fset.Position(current.Sel.Pos())
					findings = append(findings, Finding{File: rel, Line: pos.Line, Name: current.Sel.Name})
				}
			case *ast.CallExpr:
				selector, ok := current.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				switch selector.Sel.Name {
				case "CreateJobObject", "SetInformationJobObject", "TerminateJobObject":
					pos := fset.Position(selector.Sel.Pos())
					findings = append(findings, Finding{File: rel, Line: pos.Line, Name: selector.Sel.Name})
				}
			}
			return true
		})
		return nil
	})
	return findings, err
}

func isLaunchOwner(rel string) bool {
	for _, owner := range ownerDirectories {
		if rel == owner || strings.HasPrefix(rel, owner+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
