package v2cli

import (
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/secrets"
)

// case: S-222.11
func TestFirstAdminDisclosureMarkerFollowsSuccessfulResultWrite(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	const password = "handoff-test-password-sentinel"
	if err := store.Put("gateway.bootstrap.password", password); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	value := applyCommandResult{
		OK:                  true,
		Operation:           "install",
		Receipt:             contracts.InstallReceipt{Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root}}},
		FirstAdmin:          &firstAdminCredential{State: firstAdminDisclosed, Email: "admin@example.test", Password: password},
		disclosureStoreRoot: root,
	}

	written, failure := emitFirstAdminResult(value, "install", func() error { return errors.New("closed output") })
	if written || failure == nil || failure.Code != contracts.CodeApplyFailed {
		t.Fatalf("failed output emission = written %v, diagnostic %#v; want typed output failure", written, failure)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("failed result write recorded disclosure = %v, err %v", disclosed, err)
	}

	var output bytes.Buffer
	written, failure = emitFirstAdminResult(value, "install", func() error {
		_, err := output.WriteString(password)
		return err
	})
	if !written || failure != nil || output.String() != password {
		t.Fatalf("successful output emission did not preserve the result write; written=%v failure=%v", written, failure)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || !disclosed {
		t.Fatalf("successful result write disclosure marker = %v, err %v; want recorded", disclosed, err)
	}
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		if present, err := store.Exists(name); err != nil || present {
			t.Fatalf("disclosed bootstrap password entry %q present=%v, err=%v; want erased", name, present, err)
		}
	}
	assertSecretAbsentFromTree(t, root, password)
}

// case: S-222.13
func TestUnsupportedSecretStoreFormatUsesItsOwnCataloguedDiagnostic(t *testing.T) {
	failure := asDiag(secrets.ErrUnsupportedSecretStoreFormat)
	if failure.Code != contracts.CodeSecretStoreUnsupported {
		t.Fatalf("diagnostic code = %s", failure.Code)
	}
	catalog, ok := diag.LookupCatalog(failure.Code)
	if !ok || failure.Message != catalog.Message || failure.Hint != catalog.Hint || diag.ExitCode(failure).Code() != 1 {
		t.Fatalf("unsupported store diagnostic does not match its catalogue entry: code=%s exit=%d", failure.Code, diag.ExitCode(failure).Code())
	}
	if failure.Hint == "" || !strings.Contains(failure.Hint, "kb-create install --platform-root NEW_ROOT") {
		t.Fatal("diagnostic omitted the exact clean-root recovery command")
	}
}

func TestBootstrapLifecycleFactsHaveOnlyTypedStoreWriters(t *testing.T) {
	dir := filepath.Join("..", "..", "secrets")
	packages, err := parser.ParseDir(token.NewFileSet(), dir, func(info os.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 1 {
		t.Fatalf("parsed secrets packages = %d; want 1", len(packages))
	}
	allowed := map[string]bool{
		"mutate": true,
	}
	var lifecycleWriters []string
	factWriters := map[string]int{}
	for _, parsed := range packages {
		for _, file := range parsed.Files {
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if !ok || function.Body == nil {
					continue
				}
				ast.Inspect(function.Body, func(node ast.Node) bool {
					switch value := node.(type) {
					case *ast.CallExpr:
						selector, ok := value.Fun.(*ast.SelectorExpr)
						if !ok {
							break
						}
						switch selector.Sel.Name {
						case "writeRecord":
							lifecycleWriters = append(lifecycleWriters, function.Name.Name)
						case "SetBootstrapPassword", "MarkBootstrapCompleted", "MarkBootstrapDisclosed":
							factWriters[function.Name.Name+"."+selector.Sel.Name]++
						}
					}
					return true
				})
			}
		}
	}
	for _, owner := range lifecycleWriters {
		if !allowed[owner] {
			t.Fatalf("typed lifecycle write added in %s", owner)
		}
	}
	if len(lifecycleWriters) != len(allowed) {
		t.Fatalf("typed lifecycle write owners = %v", lifecycleWriters)
	}
	wantFactWriters := map[string]int{
		"setBootstrapPassword.SetBootstrapPassword":     1,
		"MarkBootstrapCompleted.MarkBootstrapCompleted": 1,
		"MarkBootstrapDisclosed.MarkBootstrapDisclosed": 1,
	}
	if !reflect.DeepEqual(factWriters, wantFactWriters) {
		t.Fatalf("bootstrap lifecycle fact writers = %v; want %v", factWriters, wantFactWriters)
	}
}

func assertSecretAbsentFromTree(t *testing.T, root, secret string) {
	assertSecretsAbsentFromTrees(t, []string{secret}, root)
}

func assertSecretsAbsentFromTrees(t *testing.T, secrets []string, roots ...string) {
	t.Helper()
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				info, err = os.Stat(path)
				if os.IsNotExist(err) {
					return nil
				}
				if err != nil {
					return err
				}
			}
			if info.IsDir() {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, secret := range secrets {
				if secret != "" && bytes.Contains(data, []byte(secret)) {
					t.Errorf("secret material remains in file %s", path)
					break
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestFirstAdminPasswordResultHasSingleProvenanceOwner(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var constructors []string
	var passwordAssignments []string
	var passwordFields []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				literal, ok := node.(*ast.CompositeLit)
				if ok {
					identifier, ok := literal.Type.(*ast.Ident)
					if ok && identifier.Name == "firstAdminCredential" {
						constructors = append(constructors, function.Name.Name)
						for _, element := range literal.Elts {
							field, ok := element.(*ast.KeyValueExpr)
							if !ok {
								passwordAssignments = append(passwordAssignments, function.Name.Name)
								continue
							}
							key, ok := field.Key.(*ast.Ident)
							if ok && key.Name == "Password" {
								passwordFields = append(passwordFields, function.Name.Name)
								if function.Name.Name != "firstAdminResult" {
									passwordAssignments = append(passwordAssignments, function.Name.Name)
								}
							}
						}
					}
				}
				assignment, ok := node.(*ast.AssignStmt)
				if ok {
					for _, expression := range assignment.Lhs {
						selector, ok := expression.(*ast.SelectorExpr)
						if ok && selector.Sel.Name == "Password" && function.Name.Name != "firstAdminResult" {
							passwordAssignments = append(passwordAssignments, function.Name.Name)
						}
					}
				}
				return true
			})
		}
	}
	allowed := map[string]int{"firstAdminResult": 2, "previouslyDisclosedFirstAdmin": 1}
	constructorCounts := map[string]int{}
	for _, name := range constructors {
		constructorCounts[name]++
	}
	if !reflect.DeepEqual(constructorCounts, allowed) || len(passwordAssignments) != 0 || !reflect.DeepEqual(passwordFields, []string{"firstAdminResult"}) {
		t.Fatalf("first-admin result construction outside provenance owners: constructors=%v password assignments=%v", constructors, passwordAssignments)
	}
}

func TestBootstrapDisclosureMarkerHasOnePostWriteOwner(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var writers, setterCallers []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "MarkBootstrapDisclosed" {
					writers = append(writers, function.Name.Name)
				}
				if identifier, ok := call.Fun.(*ast.Ident); ok && identifier.Name == "setBootstrapDisclosed" {
					setterCallers = append(setterCallers, function.Name.Name)
				}
				return true
			})
		}
	}
	if !reflect.DeepEqual(writers, []string{"setBootstrapDisclosed"}) {
		t.Fatalf("atomic bootstrap disclosure owners = %v; want only setBootstrapDisclosed", writers)
	}
	if !reflect.DeepEqual(setterCallers, []string{"emitFirstAdminResult"}) {
		t.Fatalf("disclosure setter callers = %v; want only emitFirstAdminResult", setterCallers)
	}
}
