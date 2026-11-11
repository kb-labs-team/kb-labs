package secretstate

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

func TestHostProjectionSuppressesCompletedBootstrapPassword(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".kb", "v2", "secret-state.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	record := NewRecord()
	record.SetRequirement(BootstrapPasswordEnvironment, "private-test-value")
	record.SetRequirement("APP_TOKEN", "other-private-test-value")
	record.MarkBootstrapCompleted("provisioned")
	data, err := Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	projection, err := HostEnvironmentAtRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := projection.Values[BootstrapPasswordEnvironment]; found {
		t.Fatal("completed bootstrap password was projected to the host")
	}
	if projection.Values["APP_TOKEN"] != "other-private-test-value" {
		t.Fatal("unrelated declared environment secret was not projected")
	}
	if len(projection.Suppressed) != 1 || projection.Suppressed[0] != BootstrapPasswordEnvironment {
		t.Fatalf("suppressed values = %v", projection.Suppressed)
	}
}

func TestHostProjectionRefusesUnknownFieldsThroughRootLoader(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".kb", "v2", "secret-state.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schema":2,"generation":1,"requirements":{},"bootstrap":{},"extra":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := HostEnvironmentAtRoot(root)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != UnsupportedCode {
		t.Fatalf("unknown-field diagnosis = %v; want %s", err, UnsupportedCode)
	}
}

func TestRecordCommitRejectsAStalePreDisclosureSnapshot(t *testing.T) {
	base := NewRecord()
	base.SetBootstrapPassword("lifecycle-test-value", OriginGenerated)
	encoded, err := Encode(base)
	if err != nil {
		t.Fatal("encode starting record")
	}
	stale, err := Decode(encoded)
	if err != nil {
		t.Fatal("decode stale snapshot")
	}
	current, err := Decode(encoded)
	if err != nil {
		t.Fatal("decode current snapshot")
	}
	current.MarkBootstrapDisclosed()
	if !current.AdvanceFrom(base) {
		t.Fatal("current disclosure transition was refused")
	}
	stale.SetRequirement("unrelated.requirement", "unrelated-value")
	if stale.AdvanceFrom(current) {
		t.Fatal("stale pre-disclosure snapshot was allowed to overwrite the current record")
	}
}

func TestUnknownAndMalformedRecordsReturnCataloguedDiagnosis(t *testing.T) {
	for name, data := range map[string][]byte{
		"unknown schema": []byte(`{"schema":99,"requirements":{},"bootstrap":{}}`),
		"malformed":      []byte(`{"schema":`),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Decode(data)
			if !errors.Is(err, ErrUnsupportedFormat) {
				t.Fatalf("decode error does not identify unsupported secret-state format: %v", err)
			}
			var failure *diag.Diag
			if !errors.As(err, &failure) {
				t.Fatalf("decode error = %T; want catalogued diagnostic", err)
			}
			catalog, ok := diag.LookupCatalog(UnsupportedCode)
			if !ok || failure.Code != UnsupportedCode || failure.Message != catalog.Message || failure.Hint != catalog.Hint {
				t.Fatalf("diagnostic = %#v; catalog entry = %#v", failure, catalog)
			}
		})
	}
}

// This rail prevents accidental second readers by rejecting record-name or layout-ID references outside the owner and layout accessor; code review, not this rail, covers deliberate evasion.
func TestSecretStateAccessHasOneRepositoryOwner(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate repository root for access rail")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	violations, err := privateRecordReferences(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != 0 {
		t.Fatalf("private secret record path may only be named by its layout and shared owner; found references in %v", violations)
	}
}

func TestRecordPathAccessorCannotCompileInAnotherPackage(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate repository root for compile rail")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), ".."))
	dir := t.TempDir()
	module := "module recordpathmutation\n\ngo 1.22\n\nrequire github.com/kb-labs/clikit v0.0.0\n\nreplace github.com/kb-labs/clikit => " + filepath.ToSlash(moduleRoot) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(module), 0o600); err != nil {
		t.Fatal(err)
	}
	contents := "package operationlock\nimport \"github.com/kb-labs/clikit/secretstate\"\nvar _ = secretstate.RecordPath\n"
	if err := os.WriteFile(filepath.Join(dir, "record_path_mutation.go"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "test", "-mod=mod", ".")
	command.Dir = dir
	command.Env = append(os.Environ(), "GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "undefined: secretstate.RecordPath") {
		t.Fatalf("path-accessor mutation compiled or failed for another reason: %v\n%s", err, output)
	}
}

func TestSecretStateAccessRailRejectsEverySourceLanguage(t *testing.T) {
	for relative, source := range map[string]string{
		"tools/kb-create/v2/other/map.go":          `json.Unmarshal(data, &map[string]any{}); open(".kb/v2/secret-state.json")`,
		"tools/kb-monitor/main.go":                 `json.Unmarshal(data, &map[string]any{}); open(".kb/v2/secret-state.json")`,
		"tools/kb-create/v2/other/raw.go":          `json.Unmarshal(data, &json.RawMessage{}); open(".kb/v2/secret-state.json")`,
		"tools/kb-create/v2/contracts/other.go":    `const privateState = "secret-state.json"`,
		"e2e/journey/layout_reader.py":             `layout["sharedRuntimePaths"] and entry["id"] == "secretState"`,
		"services/gateway/app/src/private.test.ts": `readFileSync('.kb/v2/secret-state.json')`,
		"e2e/journey/private_steps.py":             `open('.kb/v2/secret-state.json')`,
		"scripts/private-check.sh":                 `cat .kb/v2/secret-state.json | jq .`,
	} {
		t.Run(relative, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
				t.Fatal(err)
			}
			violations, err := privateRecordReferences(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(violations) != 1 || violations[0] != filepath.ToSlash(relative) {
				t.Fatalf("access rail violations = %v; want only %s", violations, relative)
			}
		})
	}
}

func privateRecordReferences(root string) ([]string, error) {
	ownerFiles := map[string]bool{}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		return nil, errors.New("locate secret-state owner package")
	}
	repository := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", ".."))
	ownerDir := filepath.Dir(sourceFile)
	if err := filepath.WalkDir(ownerDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".go" {
			return err
		}
		relative, err := filepath.Rel(repository, path)
		if err == nil {
			ownerFiles[filepath.ToSlash(relative)] = true
		}
		return err
	}); err != nil {
		return nil, err
	}
	layoutAccessor := filepath.Join(root, "tools", "kb-create", "v2", "contracts", "layout.go")
	if data, err := os.ReadFile(layoutAccessor); err == nil {
		if strings.Count(string(data), `"secretState"`) != 1 || strings.Contains(string(data), "secret-state.json") {
			return []string{"tools/kb-create/v2/contracts/layout.go"}, nil
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	var violations []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "dist" {
				return filepath.SkipDir
			}
			return nil
		}
		extension := filepath.Ext(path)
		switch extension {
		case ".go", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".zsh":
		default:
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if ownerFiles[relative] || relative == "tools/kb-create/v2/contracts/platform-layout.json" || relative == "tools/kb-create/v2/contracts/layout.go" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), "secret-state.json") || strings.Contains(string(data), "secretState") {
			violations = append(violations, relative)
		}
		return nil
	})
	return violations, err
}
