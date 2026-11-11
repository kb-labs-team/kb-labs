package diag

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag/catalogcheck"
)

// case: S-203.2
func TestKBCodeLiteralsExistInPlatformCatalog(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(root, "core", "platform", "src", "error-envelope", "errors.catalog.json")
	content, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Codes                []CatalogEntry `json:"codes"`
		EnvironmentVariables []string       `json:"environmentVariables"`
	}
	if err := json.Unmarshal(content, &catalog); err != nil {
		t.Fatal(err)
	}
	entries := make(map[string]CatalogEntry, len(catalog.Codes))
	entryCodes := make(map[string]struct{}, len(catalog.Codes))
	for _, entry := range catalog.Codes {
		if entry.Area == "" || entry.Severity == "" || entry.Message == "" || entry.Hint == "" ||
			(entry.ProcessExitClass != ExitClassInputRefusal && entry.ProcessExitClass != ExitClassOperationFailure) {
			t.Errorf("catalog entry %s is missing required metadata or process exit class", entry.Code)
		}
		entries[entry.Code] = CatalogEntry(entry)
		entryCodes[entry.Code] = struct{}{}
		if embedded, ok := LookupCatalog(entry.Code); ok {
			embedded.TemplateParameters = nil
			embedded.RequiredTemplateParameters = nil
			platformEntry := CatalogEntry(entry)
			platformEntry.TemplateParameters = nil
			platformEntry.RequiredTemplateParameters = nil
			if !reflect.DeepEqual(embedded, platformEntry) {
				t.Errorf("clikit metadata for %s differs from the platform catalog", entry.Code)
			}
		} else {
			t.Errorf("clikit metadata for %s is missing", entry.Code)
		}
	}
	if len(catalogEntries) != len(entries) {
		t.Fatalf("generated Go catalog has %d entries; platform catalog has %d", len(catalogEntries), len(entries))
	}

	if !reflect.DeepEqual(catalog.EnvironmentVariables, CatalogEnvironmentVariableNames()) {
		t.Fatalf("generated environment variables = %v, want catalogue values %v", CatalogEnvironmentVariableNames(), catalog.EnvironmentVariables)
	}
	scan, err := catalogcheck.Scan(filepath.Join(root, "tools"), CatalogEnvironmentVariableNames())
	if err != nil {
		t.Fatal(err)
	}
	missing := catalogcheck.Uncatalogued(scan.Codes, entryCodes)
	for code, locations := range missing {
		relative := make([]string, 0, len(locations))
		for _, location := range locations {
			if value, err := filepath.Rel(root, location); err == nil {
				relative = append(relative, value)
			}
		}
		t.Errorf("Go tool emits uncatalogued code %s in %s", code, strings.Join(relative, ", "))
	}
}

func TestCatalogDeclaresEnvironmentVariableNames(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "core", "platform", "src", "error-envelope", "errors.catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		EnvironmentVariables []string `json:"environmentVariables"`
	}
	if err := json.Unmarshal(content, &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.EnvironmentVariables) == 0 {
		t.Fatal("shared error catalogue declares no environment variable names")
	}
	if !reflect.DeepEqual(catalog.EnvironmentVariables, CatalogEnvironmentVariableNames()) {
		t.Fatalf("generated environment variables = %v, want catalogue values %v", CatalogEnvironmentVariableNames(), catalog.EnvironmentVariables)
	}
	toolsDir := filepath.Join(t.TempDir(), "tools", "fixture")
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	var source strings.Builder
	source.WriteString("package fixture\n")
	for _, name := range catalog.EnvironmentVariables {
		fmt.Fprintf(&source, "var _ = %q\n", name)
	}
	fixture := filepath.Join(toolsDir, "fixture.go")
	if err := os.WriteFile(fixture, []byte(source.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	scan, err := catalogcheck.Scan(filepath.Dir(filepath.Dir(toolsDir)), CatalogEnvironmentVariableNames())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range catalog.EnvironmentVariables {
		if _, exists := scan.Codes[name]; exists {
			t.Errorf("catalogued environment variable %s was reported as a diagnostic code", name)
		}
	}
}

func TestCatalogGeneratesRequiredTemplateParameters(t *testing.T) {
	entry, ok := LookupCatalog("KB_AUTH_FORBIDDEN")
	if !ok {
		t.Fatal("KB_AUTH_FORBIDDEN is absent from generated catalog")
	}
	if !reflect.DeepEqual(entry.RequiredTemplateParameters, []string{"permission"}) {
		t.Fatalf("generated required parameters = %v, want [permission]", entry.RequiredTemplateParameters)
	}
}

func TestCatalogGeneratesStructuredDetailFields(t *testing.T) {
	entry, ok := LookupCatalog("KB_AUTH_SESSION_REVOKED")
	if !ok {
		t.Fatal("KB_AUTH_SESSION_REVOKED is absent from generated catalog")
	}
	if !reflect.DeepEqual(entry.StructuredDetailFields, []string{"reason", "remoteCorrelationId"}) {
		t.Fatalf("generated structured detail fields = %v, want [reason remoteCorrelationId]", entry.StructuredDetailFields)
	}
}

func TestInvalidConfigCatalogIncludesHostReadinessEvidence(t *testing.T) {
	entry, ok := LookupCatalog("KB_CONFIG_INVALID")
	if !ok {
		t.Fatal("KB_CONFIG_INVALID is absent from generated catalog")
	}
	for _, field := range []string{"readinessError", "readinessURL", "waited"} {
		if !contains(entry.StructuredDetailFields, field) {
			t.Errorf("KB_CONFIG_INVALID does not declare host startup detail %q", field)
		}
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestGoToolsDoNotAssignProcessExitStatusOutsideDiag(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	ownerDir, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	toolsDir := filepath.Join(root, "tools")
	check := func(source string) bool {
		file, err := parser.ParseFile(token.NewFileSet(), "fixture.go", source, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.SelectorExpr:
				if value.Sel.Name == "ProcessExitCode" || value.Sel.Name == "ProcessExitClass" || value.Sel.Name == "WithProcessExitCode" {
					found = true
				}
			case *ast.KeyValueExpr:
				if key, ok := value.Key.(*ast.Ident); ok && (key.Name == "ProcessExitCode" || key.Name == "ProcessExitClass") {
					found = true
				}
			}
			return true
		})
		return found
	}
	if !check("package p\nfunc f() { failure.ProcessExitClass = \"input-refusal\" }\n") {
		t.Fatal("rail mutation was not detected")
	}
	err = filepath.WalkDir(toolsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() && (entry.Name() == "vendor" || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			absolute, _ := filepath.Abs(path)
			if absolute == ownerDir {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if check(string(source)) {
			relative, _ := filepath.Rel(root, path)
			t.Errorf("%s assigns or constructs a process exit status outside the diag owner", relative)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGoToolsHaveOneTypedProcessExitOwner(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	toolsDir := filepath.Join(root, "tools")
	expectedOwner := filepath.Join(toolsDir, "clikit", "command", "process.go")
	if err := validateTypedProcessExitOwner(toolsDir, expectedOwner); err != nil {
		t.Fatal(err)
	}

	mutations := []struct {
		name, source string
	}{
		{"wrapper-code", `package p; import "os"; type wrapper struct{}; func (wrapper) Code() int { return 2 }; func f() { os.Exit(wrapper{}.Code()) }`},
		{"alias", `package p; import "os"; func f() { exit := os.Exit; exit(2) }`},
		{"syscall-helper", `package helper; import "syscall"; func helper() { syscall.Exit(2) }`},
		{"log-fatal", `package p; import "log"; func handler() { log.Fatal("x") }`},
		{"new-main", `package main; import "os"; func main() { os.Exit(2) }`},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			mutationTools := filepath.Join(t.TempDir(), "tools")
			if err := writeExitOwnerFixture(mutationTools); err != nil {
				t.Fatal(err)
			}
			mutationDirectory := filepath.Join(mutationTools, "mutation")
			if mutation.name == "syscall-helper" {
				mutationDirectory = filepath.Join(mutationTools, "sixth-binary", "internal", "helper")
			}
			if err := os.MkdirAll(mutationDirectory, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(mutationDirectory, "mutation.go"), []byte(mutation.source), 0o600); err != nil {
				t.Fatal(err)
			}
			if mutation.name == "syscall-helper" {
				mainDirectory := filepath.Join(mutationTools, "sixth-binary")
				if err := os.MkdirAll(mainDirectory, 0o755); err != nil {
					t.Fatal(err)
				}
				mainSource := `package main
import command "github.com/kb-labs/clikit/command"
func main() { command.Exit(2) }
`
				if err := os.WriteFile(filepath.Join(mainDirectory, "main.go"), []byte(mainSource), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := validateTypedProcessExitOwner(mutationTools, filepath.Join(mutationTools, "clikit", "command", "process.go")); err == nil {
				t.Fatal("mutation passed the process exit rail")
			}
		})
	}
}

func validateTypedProcessExitOwner(toolsDir, expectedOwner string) error {
	packages, mains, err := loadToolPackages(toolsDir)
	if err != nil {
		return err
	}
	var exits []string
	for directory, pkg := range packages {
		aliases := terminationAliases(pkg.files, pkg.info)
		for _, file := range pkg.files {
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if ok && isProcessTermination(call.Fun, pkg.info, aliases) {
					exits = append(exits, filepath.Join(directory, filepath.Base(pkg.fset.Position(call.Pos()).Filename))+":"+strconv.Itoa(pkg.fset.Position(call.Pos()).Line))
				}
				return true
			})
		}
	}
	if len(exits) != 1 || !strings.HasPrefix(exits[0], expectedOwner+":") {
		return fmt.Errorf("process termination sites = %v; want only %s", exits, expectedOwner)
	}
	for directory, files := range mains {
		if countSharedExitCalls(files) != 1 {
			return fmt.Errorf("package main in %s must hand one typed status to clikit/command.Exit", directory)
		}
	}
	return nil
}

func writeExitOwnerFixture(toolsDir string) error {
	ownerDirectory := filepath.Join(toolsDir, "clikit", "command")
	if err := os.MkdirAll(ownerDirectory, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(ownerDirectory, "process.go"), []byte(`package command
import "os"
func Exit(status int) { os.Exit(status) }
`), 0o600)
}

type parsedToolPackage struct {
	fset  *token.FileSet
	files []*ast.File
	info  *types.Info
}

func loadToolPackages(toolsDir string) (map[string]parsedToolPackage, map[string][]*ast.File, error) {
	packages := map[string]parsedToolPackage{}
	mains := map[string][]*ast.File{}
	byDirectory := map[string][]string{}
	err := filepath.WalkDir(toolsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != toolsDir && (entry.Name() == "vendor" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) == ".go" && !strings.HasSuffix(path, "_test.go") {
			byDirectory[filepath.Dir(path)] = append(byDirectory[filepath.Dir(path)], path)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	for directory, paths := range byDirectory {
		fset := token.NewFileSet()
		var files []*ast.File
		packageName := ""
		for _, path := range paths {
			file, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return nil, nil, err
			}
			if packageName == "" {
				packageName = file.Name.Name
			}
			if file.Name.Name != packageName {
				continue
			}
			files = append(files, file)
		}
		info := &types.Info{Types: make(map[ast.Expr]types.TypeAndValue), Defs: make(map[*ast.Ident]types.Object), Uses: make(map[*ast.Ident]types.Object), Selections: make(map[*ast.SelectorExpr]*types.Selection)}
		config := types.Config{Importer: importer.Default(), Error: func(error) {}}
		_, _ = config.Check(filepath.ToSlash(directory), fset, files, info)
		packages[directory] = parsedToolPackage{fset: fset, files: files, info: info}
		if packageName == "main" {
			mains[directory] = files
		}
	}
	return packages, mains, nil
}

func terminationAliases(files []*ast.File, info *types.Info) map[types.Object]bool {
	aliases := map[types.Object]bool{}
	for pass := 0; pass < 2; pass++ {
		for _, file := range files {
			ast.Inspect(file, func(node ast.Node) bool {
				var names []*ast.Ident
				var values []ast.Expr
				switch value := node.(type) {
				case *ast.AssignStmt:
					for _, lhs := range value.Lhs {
						if ident, ok := lhs.(*ast.Ident); ok {
							names = append(names, ident)
						} else {
							names = append(names, nil)
						}
					}
					values = value.Rhs
				case *ast.ValueSpec:
					names, values = value.Names, value.Values
				}
				for index, name := range names {
					if name == nil || index >= len(values) {
						continue
					}
					object := info.Defs[name]
					if object == nil {
						object = info.Uses[name]
					}
					if object != nil && isProcessObject(usedObject(values[index], info), aliases) {
						aliases[object] = true
					}
				}
				return true
			})
		}
	}
	return aliases
}

func usedObject(expression ast.Expr, info *types.Info) types.Object {
	switch value := expression.(type) {
	case *ast.Ident:
		return info.Uses[value]
	case *ast.SelectorExpr:
		if selection := info.Selections[value]; selection != nil {
			return selection.Obj()
		}
		return info.Uses[value.Sel]
	}
	return nil
}

func isProcessObject(object types.Object, aliases map[types.Object]bool) bool {
	if object == nil {
		return false
	}
	if aliases[object] {
		return true
	}
	pkg := object.Pkg()
	if pkg == nil {
		return false
	}
	name := object.Name()
	switch pkg.Path() {
	case "os", "syscall":
		return name == "Exit"
	case "log":
		return strings.HasPrefix(name, "Fatal")
	case "runtime":
		return name == "Goexit"
	default:
		return false
	}
}

func isProcessTermination(expression ast.Expr, info *types.Info, aliases map[types.Object]bool) bool {
	return isProcessObject(usedObject(expression, info), aliases)
}

func countSharedExitCalls(files []*ast.File) int {
	count := 0
	for _, file := range files {
		imports := map[string]string{}
		for _, imported := range file.Imports {
			path, err := strconv.Unquote(imported.Path.Value)
			if err != nil || path != "github.com/kb-labs/clikit/command" {
				continue
			}
			name := filepath.Base(path)
			if imported.Name != nil {
				name = imported.Name.Name
			}
			imports[name] = path
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Exit" {
				return true
			}
			owner, ok := selector.X.(*ast.Ident)
			if ok && imports[owner.Name] == "github.com/kb-labs/clikit/command" {
				count++
			}
			return true
		})
	}
	return count
}

func TestExitStatusTypeRejectsIntegerAndWrappedLiteralMutations(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, ".exitstatusmutation-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("remove mutation fixtures: %v", err)
		}
	})
	fixtures := []string{
		`package mutation
import ("github.com/kb-labs/clikit/diag"; "github.com/kb-labs/clikit/result")
func chosen(d *diag.Diag) int { if d.Code != "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE" { return 0 }; return 2 }
func bad() { _ = result.StreamComplete(chosen(diag.New("KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE", "bad"))) }`,
		`package mutation
import "github.com/kb-labs/clikit/result"
func bad() { _ = result.StreamComplete(2) }`,
		`package mutation
import "github.com/kb-labs/clikit/result"
func leaf() int { return 2 }
func middle() int { return leaf() }
func bad() { _ = result.StreamComplete(middle()) }`,
	}
	for index, source := range fixtures {
		fixtureDir := filepath.Join(dir, fmt.Sprintf("fixture-%d", index+1))
		if err := os.Mkdir(fixtureDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fixtureDir, "mutation.go"), []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
		command := exec.Command("go", "test", "-mod=readonly", ".")
		command.Dir = fixtureDir
		command.Env = append(os.Environ(), "GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local")
		if output, err := command.CombinedOutput(); err == nil {
			t.Errorf("mutation fixture %d compiled; typed exit status accepted a literal: %s", index+1, output)
		} else if !strings.Contains(string(output), "diag.ExitStatus") {
			t.Errorf("mutation fixture %d failed for a reason unrelated to the typed status boundary: %s", index+1, output)
		}
	}
}

func TestCatalogScannerRejectsUncataloguedFixtureLiteral(t *testing.T) {
	toolsDir := filepath.Join(t.TempDir(), "tools", "fixture")
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(toolsDir, "fixture.go")
	if err := os.WriteFile(fixture, []byte("package fixture\nconst code = \"KB_FIXTURE_404\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scan, err := catalogcheck.Scan(filepath.Dir(filepath.Dir(toolsDir)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if missing := catalogcheck.Uncatalogued(scan.Codes, map[string]struct{}{}); len(missing) != 1 {
		t.Fatalf("uncatalogued fixture should fail catalog check; got missing codes %v", missing)
	} else if _, ok := missing["KB_FIXTURE_404"]; !ok {
		t.Fatalf("uncatalogued fixture was not rejected: %v", missing)
	}
}

func TestCatalogScannerIgnoresKBMapIndexKeys(t *testing.T) {
	toolsDir := filepath.Join(t.TempDir(), "tools", "fixture")
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(toolsDir, "fixture.go")
	if err := os.WriteFile(fixture, []byte("package fixture\nvar env = map[string]string{}\nfunc set() { env[\"KB_INSTALLATION_ID\"] = \"id\" }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scan, err := catalogcheck.Scan(filepath.Dir(filepath.Dir(toolsDir)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := scan.Codes["KB_INSTALLATION_ID"]; exists {
		t.Fatalf("map index key was reported as a diagnostic code: %v", scan.Codes)
	}
}
