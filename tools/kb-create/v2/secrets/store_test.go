package secrets

import (
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/secretstate"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestStaleStoreCommandRoundTripsPlatformRootThroughPOSIXShell(t *testing.T) {
	root := filepath.Join(t.TempDir(), "KB Labs; $(touch SHOULD_NOT_RUN) 'prod'")
	command := "set -- " + staleWriteRerunCommand(root) + `; printf '%s\0' "$@"`
	output, err := exec.Command("/bin/sh", "-c", command).Output()
	if err != nil {
		t.Fatalf("shell could not parse the rerun command: %v", err)
	}
	got := strings.Split(string(output), "\x00")
	got = got[:len(got)-1]
	want := []string{"kb-create", "apply", "--platform-root", root}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shell argv = %#v; want %#v", got, want)
	}
}

// This accidental-source rail scans every production Go file in kb-create v2
// for a command string that combines a kb-create invocation and a path-like
// value without passing through the shared shell command renderer. It does not
// attempt to detect deliberate evasion, which remains a code-review concern.
func TestCommandHintsDoNotHandFormatDynamicCLIArguments(t *testing.T) {
	root := filepath.Clean("..")
	fset := token.NewFileSet()
	var violations []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			var expression ast.Expr
			switch current := node.(type) {
			case *ast.BinaryExpr:
				if current.Op == token.ADD && containsCLIInvocation(current) && containsPathOrAccountValue(current) && !containsShellCommand(current) {
					expression = current
				}
			case *ast.CallExpr:
				if len(current.Args) > 1 && isFmtSprintf(current.Fun) && containsCLIInvocation(current.Args[0]) && containsPathOrAccountValue(current) && !containsShellCommand(current) {
					expression = current
				}
			}
			if expression != nil {
				violations = append(violations, fset.Position(expression.Pos()).String())
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("dynamic CLI hints must render argv with contracts.ShellCommand: %s", strings.Join(violations, ", "))
	}
}

func isFmtSprintf(expression ast.Expr) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "Sprintf" {
		return false
	}
	pkg, ok := selector.X.(*ast.Ident)
	return ok && pkg.Name == "fmt"
}

func containsCLIInvocation(expression ast.Node) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if ok && literal.Kind == token.STRING && strings.Contains(literal.Value, "kb-create") {
			found = true
		}
		return !found
	})
	return found
}

func containsPathOrAccountValue(expression ast.Node) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		var name string
		switch current := node.(type) {
		case *ast.Ident:
			name = current.Name
		case *ast.SelectorExpr:
			name = current.Sel.Name
		}
		name = strings.ToLower(name)
		if strings.Contains(name, "root") || strings.Contains(name, "path") || strings.Contains(name, "dir") ||
			strings.Contains(name, "url") || strings.Contains(name, "email") {
			found = true
		}
		return !found
	})
	return found
}

func containsShellCommand(expression ast.Node) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return !found
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "ShellCommand" {
			found = true
		}
		return !found
	})
	return found
}

func TestStoreIsPrivateAndSupportsExistenceOnly(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.Put("OPENAI_API_KEY", "super-secret"); err != nil {
		t.Fatal(err)
	}
	exists, err := store.Exists("OPENAI_API_KEY")
	if err != nil || !exists {
		t.Fatalf("exists/error = %v / %v", exists, err)
	}
	hits := filesContaining(t, root, "super-secret")
	if len(hits) != 1 {
		t.Fatal("secret store write did not produce one file")
	}
	info, err := os.Stat(filepath.Join(root, hits[0].relative))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode/error = %v / %v", info.Mode(), err)
	}
}

func TestStoreUsesVersionrootSharedPathDespiteStableContractMarker(t *testing.T) {
	installRoot := t.TempDir()
	versionRoot := filepath.Join(installRoot, "versions", "v1")
	for _, root := range []string{
		filepath.Join(versionRoot, ".kb", "v2"),
		filepath.Join(installRoot, ".kb", "v2"),
	} {
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatalf("create layout contract directory: %v", err)
		}
	}
	contract := contracts.PlatformLayoutDocument()
	if err := os.WriteFile(filepath.Join(versionRoot, ".kb", "v2", "platform-layout.json"), contract, 0o600); err != nil {
		t.Fatalf("write active version contract: %v", err)
	}
	if err := os.WriteFile(filepath.Join(installRoot, ".kb", "v2", "platform-layout.json"), contract, 0o600); err != nil {
		t.Fatalf("write stable-root marker fixture: %v", err)
	}
	if err := os.Symlink(filepath.Join("versions", "v1"), filepath.Join(installRoot, "current")); err != nil {
		t.Fatalf("create current link: %v", err)
	}

	layout, err := versionroot.ForPlatformPath(installRoot)
	if err != nil {
		t.Fatalf("resolve install layout: %v", err)
	}
	want, err := layout.SharedRuntimePath(contracts.SharedRecordPath())
	if err != nil {
		t.Fatalf("resolve layout-owned shared path: %v", err)
	}
	store := Store{PlatformRoot: installRoot}
	if err := store.Put("fixture", "value"); err != nil {
		t.Fatalf("store secret: %v", err)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("secret record missing from versionroot-owned shared path %s: %v", want, err)
	}
	stablePath := filepath.Join(installRoot, filepath.FromSlash(contracts.SharedRecordPath()))
	if _, err := os.Stat(stablePath); err == nil {
		t.Fatalf("secret record followed stable-root marker to %s", stablePath)
	} else if !os.IsNotExist(err) {
		t.Fatalf("inspect stable-root path: %v", err)
	}
}

func TestStoreRejectsUnknownRecordFieldWithCataloguedDiagnosis(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	store.atomicWrite = func(path string, _ []byte, mode os.FileMode) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		return os.WriteFile(path, []byte(`{"schema":2,"generation":1,"requirements":{},"bootstrap":{},"extra":true}`), mode)
	}
	if err := store.Put("fixture", "value"); err != nil {
		t.Fatal("write malformed record fixture")
	}
	_, err := store.readRecord()
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != secretstate.UnsupportedCode {
		t.Fatalf("unknown-field diagnosis = %v; want %s", err, secretstate.UnsupportedCode)
	}
}

// case: S-100.1
func TestBootstrapValueAndFactsShareOneAtomicRecord(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.PutBootstrapPassword("bootstrap-transition-sentinel", BootstrapOriginGenerated); err != nil {
		t.Fatal("store bootstrap credential")
	}
	record, err := store.readRecord()
	if err != nil {
		t.Fatalf("read typed atomic secret state: %v", err)
	}
	if value, present := record.Requirement(BootstrapPassword); !present || value != "bootstrap-transition-sentinel" {
		t.Fatal("typed record omitted the bootstrap requirement")
	}
	if origin, present := record.BootstrapPasswordOrigin(); !present || origin != BootstrapOriginGenerated {
		t.Fatal("typed record omitted generated password provenance")
	}
	hits := filesContaining(t, root, "bootstrap-transition-sentinel")
	if len(hits) != 1 {
		t.Fatalf("atomic record files containing the sentinel = %d; want one", len(hits))
	}
	for _, field := range []string{`"requirements"`, `"bootstrap"`, `"generated"`} {
		if !bytes.Contains(hits[0].data, []byte(field)) {
			t.Fatalf("atomic state omitted required field %s", field)
		}
	}
}

// case: S-100.1
func TestLaterStoreMutationKeepsDisclosedBootstrapState(t *testing.T) {
	root := t.TempDir()
	base := Store{PlatformRoot: root}
	if err := base.PutBootstrapPassword("writer-order-sentinel", BootstrapOriginGenerated); err != nil {
		t.Fatal("seed lifecycle record")
	}
	if err := base.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal("complete bootstrap")
	}
	if err := base.MarkBootstrapDisclosed(); err != nil {
		t.Fatal("record disclosure")
	}
	if err := base.Put("unrelated.requirement", "unrelated-value"); err != nil {
		t.Fatalf("later store mutation: %v", err)
	}

	disclosed, err := base.BootstrapDisclosed()
	if err != nil || !disclosed {
		t.Fatalf("disclosure state after overlapping writer: disclosed=%v err=%v", disclosed, err)
	}
	for _, name := range []string{BootstrapPassword, BootstrapPasswordEnvironment} {
		if _, present, err := base.Get(name); err != nil || present {
			t.Fatalf("disclosed password entry %q present=%v err=%v", name, present, err)
		}
	}
}

// case: S-100.1
func TestBootstrapOriginTransitionsRemainAtomicAtEveryCommitBoundary(t *testing.T) {
	transitions := []struct {
		name       string
		fromOrigin BootstrapPasswordOrigin
		toOrigin   BootstrapPasswordOrigin
		completed  bool
		locked     bool
	}{
		{name: "generated to supplied while pending", fromOrigin: BootstrapOriginGenerated, toOrigin: BootstrapOriginSupplied},
		{name: "supplied to generated while pending", fromOrigin: BootstrapOriginSupplied, toOrigin: BootstrapOriginGenerated},
		{name: "generated rotation while pending", fromOrigin: BootstrapOriginGenerated, toOrigin: BootstrapOriginGenerated},
		{name: "supplied rotation while pending", fromOrigin: BootstrapOriginSupplied, toOrigin: BootstrapOriginSupplied},
		{name: "replacement after completion", fromOrigin: BootstrapOriginGenerated, toOrigin: BootstrapOriginSupplied, completed: true, locked: true},
	}
	for _, transition := range transitions {
		failurePoints := []string{
			"temporary-created", "temporary-chmodded", "temporary-written",
			"temporary-synced-and-closed", "renamed", "directory-synced",
		}
		for _, failurePoint := range failurePoints {
			t.Run(transition.name+"/"+failurePoint, func(t *testing.T) {
				root := t.TempDir()
				store := Store{PlatformRoot: root}
				if err := store.PutBootstrapPassword("original-transition-value", transition.fromOrigin); err != nil {
					t.Fatal("seed bootstrap state")
				}
				if transition.completed {
					if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
						t.Fatal("complete bootstrap state")
					}
				}
				writes := 0
				injected := store
				injected.atomicWrite = func(path string, data []byte, mode os.FileMode) error {
					writes++
					return versionroot.AtomicWriteFileWithBoundaryHook(path, data, mode, func(boundary string) error {
						if boundary == failurePoint {
							return errors.New("injected atomic replacement boundary failure")
						}
						return nil
					})
				}
				err := injected.PutBootstrapPassword("replacement-transition-value", transition.toOrigin)
				if transition.locked {
					if !errors.Is(err, ErrBootstrapCredentialLocked) || writes != 0 {
						t.Fatal("completed bootstrap accepted a credential replacement")
					}
				} else if err == nil || writes != 1 {
					t.Fatal("atomic replacement fault was not injected at the single state boundary")
				}

				fresh := Store{PlatformRoot: root}
				value, present, readErr := fresh.Get(BootstrapPassword)
				origin, originPresent, originErr := fresh.BootstrapOrigin()
				if readErr != nil || originErr != nil || !present || !originPresent {
					t.Fatal("fresh process could not read a complete bootstrap state")
				}
				oldState := value == "original-transition-value" && origin == transition.fromOrigin
				newState := value == "replacement-transition-value" && origin == transition.toOrigin
				if transition.locked {
					if !oldState {
						t.Fatal("completed bootstrap state changed after refusal")
					}
				} else if failurePoint != "renamed" && failurePoint != "directory-synced" && !oldState {
					t.Fatal("pre-rename failure exposed a mixed or partial state")
				} else if (failurePoint == "renamed" || failurePoint == "directory-synced") && !newState {
					t.Fatal("post-rename failure exposed a mixed or partial state")
				}
				if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
					if walkErr != nil || entry.IsDir() {
						return walkErr
					}
					data, readErr := os.ReadFile(path)
					if readErr != nil {
						return readErr
					}
					for _, pair := range []struct {
						value  string
						origin BootstrapPasswordOrigin
					}{{"original-transition-value", transition.fromOrigin}, {"replacement-transition-value", transition.toOrigin}} {
						if !bytes.Contains(data, []byte(pair.value)) {
							continue
						}
						record, decodeErr := secretstate.Decode(data)
						value, _ := record.Requirement(BootstrapPassword)
						origin, _ := record.BootstrapPasswordOrigin()
						if decodeErr != nil || value != pair.value || origin != pair.origin {
							return errors.New("a file paired a bootstrap credential with another origin")
						}
					}
					return nil
				}); err != nil {
					t.Fatal("bootstrap credential and origin diverged in a file under the install root")
				}
				disclosed, disclosedErr := fresh.BootstrapDisclosed()
				if disclosedErr != nil || disclosed {
					t.Fatal("failed replacement changed disclosure state")
				}
			})
		}
	}
}

func TestReadOnlyStoreRejectsStagedWrites(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.Put("stable", "before"); err != nil {
		t.Fatal(err)
	}
	store.ReadOnly = true
	if err := store.Put("stable", "after"); err == nil {
		t.Fatal("read-only staged secret write unexpectedly succeeded")
	}
	value, present, err := store.Get("stable")
	if err != nil || !present || value != "before" {
		t.Fatalf("read-only secret write changed the stored value: present=%v err=%v", present, err)
	}
}

func TestEnsureGeneratedCreatesPrivateRandomSecretAndPreservesSuppliedValue(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	plan := &contracts.ResolvedInstallPlan{
		Artifacts: []contracts.Artifact{{Config: []contracts.ConfigRequirement{{ID: "gateway.jwtSecret", Secret: true, Generate: true}}}},
	}
	if err := EnsureGenerated(plan, store); err != nil {
		t.Fatal(err)
	}
	first, present, err := store.Get("gateway.jwtSecret")
	if err != nil || !present || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(first) {
		t.Fatalf("generated secret availability mismatch: present=%v, err=%v", present, err)
	}
	if err := EnsureGenerated(plan, store); err != nil {
		t.Fatal(err)
	}
	second, _, _ := store.Get("gateway.jwtSecret")
	if second != first {
		t.Fatal("existing operator or generated secret was replaced")
	}
	if err := store.Put("gateway.jwtSecret", "operator-selected-secret"); err != nil {
		t.Fatal(err)
	}
	if err := EnsureGenerated(plan, store); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.Get("gateway.jwtSecret")
	if got != "operator-selected-secret" {
		t.Fatal("operator secret was not preserved")
	}
}

func TestBootstrapPasswordOriginIsAtomicWithThePassword(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	if err := store.PutBootstrapPassword("generated-test-secret", BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	password, present, err := store.Get(BootstrapPassword)
	if err != nil || !present || password != "generated-test-secret" {
		t.Fatal("generated bootstrap password was not stored")
	}
	origin, present, err := store.BootstrapOrigin()
	if err != nil || !present || origin != BootstrapOriginGenerated {
		t.Fatal("generated origin was not committed with the bootstrap password")
	}
	if err := store.Put(BootstrapPassword, "supplied-test-secret"); err != nil {
		t.Fatal(err)
	}
	origin, present, err = store.BootstrapOrigin()
	if err != nil || !present || origin != BootstrapOriginSupplied {
		t.Fatal("supplied origin was not committed with the bootstrap password")
	}
}

// case: S-038.4
func TestEnsureGeneratedInternalSecretBindsEveryProtectedService(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	plan := &contracts.ResolvedInstallPlan{
		Artifacts: []contracts.Artifact{{Config: []contracts.ConfigRequirement{{
			ID: "gateway.internalSecret", Secret: true, Generate: true, Env: "GATEWAY_INTERNAL_SECRET",
			Services: []string{"gateway", "rest", "marketplace", "marketplace-registry"},
		}}}},
	}
	if err := EnsureGenerated(plan, store); err != nil {
		t.Fatal(err)
	}
	value, present, err := store.Get("gateway.internalSecret")
	if err != nil || !present || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(value) {
		t.Fatalf("generated internal secret availability mismatch: present=%v, err=%v", present, err)
	}
	if err := store.BindEnvironments([]contracts.ConfigPatch{{
		Owner: "manifest:gateway.internalSecret", Environment: "GATEWAY_INTERNAL_SECRET",
		Services: []string{"gateway", "rest", "marketplace", "marketplace-registry"},
	}}); err != nil {
		t.Fatal(err)
	}
	environment, err := store.Environment()
	if err != nil || environment.Values["GATEWAY_INTERNAL_SECRET"] != value {
		t.Fatalf("service environment = %#v, err=%v", environment, err)
	}
}

// case: S-038.5
func TestEnsureGeneratedPreservesInternalSecretDuringUpdate(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	plan := &contracts.ResolvedInstallPlan{
		Artifacts: []contracts.Artifact{{Config: []contracts.ConfigRequirement{{ID: "gateway.internalSecret", Secret: true, Generate: true}}}},
	}
	if err := EnsureGenerated(plan, store); err != nil {
		t.Fatal(err)
	}
	before, _, _ := store.Get("gateway.internalSecret")
	if err := EnsureGenerated(plan, store); err != nil { // update resolves the same generated requirement
		t.Fatal(err)
	}
	after, _, _ := store.Get("gateway.internalSecret")
	if after != before {
		t.Fatal("update replaced generated secret")
	}
}
func TestStoreRejectsInjectionName(t *testing.T) {
	if err := (Store{PlatformRoot: t.TempDir()}).Put("TOKEN\nEVIL", "x"); err == nil {
		t.Fatal("accepted injection name")
	}
}

func TestGetReturnsStoredValueAndReportsAbsence(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	if _, present, err := store.Get("missing"); err != nil || present {
		t.Fatalf("absent secret: present=%v err=%v", present, err)
	}
	if err := store.Put("gateway.jwtSecret", "value=with=equals"); err != nil {
		t.Fatal(err)
	}
	value, present, err := store.Get("gateway.jwtSecret")
	if err != nil || !present || value != "value=with=equals" {
		t.Fatalf("secret availability mismatch: present=%v, err=%v", present, err)
	}
	if _, _, err := store.Get("bad=name"); err == nil {
		t.Fatal("an invalid name must be rejected")
	}
}

func secretsFile(t *testing.T, root string) map[string]string {
	t.Helper()
	state, err := (Store{PlatformRoot: root}).readRecord()
	if err != nil {
		t.Fatal("load typed secret state")
	}
	return state.Requirements()
}

type matchingFile struct {
	relative string
	data     []byte
}

func filesContaining(t *testing.T, root, value string) []matchingFile {
	t.Helper()
	var matches []matchingFile
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(data, []byte(value)) {
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			matches = append(matches, matchingFile{relative: relative, data: data})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func recordBytes(t *testing.T, root string) []byte {
	t.Helper()
	var match []byte
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(data, []byte(`"generation"`)) && bytes.Contains(data, []byte(`"requirements"`)) {
			if match != nil {
				return errors.New("multiple typed state records found")
			}
			match = data
		}
		return nil
	})
	if err != nil || match == nil {
		t.Fatalf("typed state record not found: %v", err)
	}
	return match
}

func gatewaySecretPatches() []contracts.ConfigPatch {
	return []contracts.ConfigPatch{
		{Path: "/gateway/access/mode", JSON: `"secured"`, Owner: "manifest:gateway.access.mode"},
		{Owner: "manifest:gateway.jwtSecret", Environment: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
		{Owner: "manifest:gateway.bootstrap.password", Environment: "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", Services: []string{"gateway"}},
	}
}

// A secret must be reachable under the environment variable name the generated
// service env references (kb-dev resolves ${GATEWAY_JWT_SECRET} by that name),
// not only under its requirement ID — whatever put it in the store.
func TestBindEnvironmentsAddsTheBoundEnvironmentKey(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	// As the wizard (or --secret-env) leaves them: keyed by requirement ID only.
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.bootstrap.password", "admin-value"); err != nil {
		t.Fatal(err)
	}
	if err := store.BindEnvironments(gatewaySecretPatches()); err != nil {
		t.Fatal(err)
	}
	got := secretsFile(t, root)
	want := map[string]string{
		"gateway.jwtSecret":                "jwt-value",
		"GATEWAY_JWT_SECRET":               "jwt-value",
		"gateway.bootstrap.password":       "admin-value",
		"GATEWAY_BOOTSTRAP_ADMIN_PASSWORD": "admin-value",
	}
	if len(got) != len(want) {
		t.Fatalf("stored secret key set mismatch: got=%v want=%v", got, want)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("stored value mismatch for secret key %s", key)
		}
	}
	if origin, present, err := store.BootstrapOrigin(); err != nil || !present || origin != BootstrapOriginSupplied {
		t.Fatal("supplied bootstrap origin was not stored in the internal lifecycle record")
	}
	if exists, err := store.Exists("gateway.jwtSecret"); err != nil || !exists {
		t.Fatalf("requirement ID must stay verifiable: %v / %v", exists, err)
	}
}

func TestBindEnvironmentsIsIdempotentAndSkipsWhatIsNotThere(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	patches := append(gatewaySecretPatches(),
		// bound to an env equal to its own ID: nothing to add
		contracts.ConfigPatch{Owner: "manifest:OPENAI_API_KEY", Environment: "OPENAI_API_KEY", Services: []string{"gateway"}},
		// a non-secret patch that happens to carry no environment
		contracts.ConfigPatch{Path: "/x", JSON: `1`, Owner: "platform"},
	)
	for i := 0; i < 2; i++ {
		if err := store.BindEnvironments(patches); err != nil {
			t.Fatal(err)
		}
	}
	got := secretsFile(t, root)
	// gateway.bootstrap.password was never provided: no alias is invented for it.
	if len(got) != 2 || got["gateway.jwtSecret"] != "jwt-value" || got["GATEWAY_JWT_SECRET"] != "jwt-value" {
		t.Fatalf("stored keys = %v", got)
	}
}

// case: S-222.11
func TestEnvironmentOmitsBootstrapPasswordAfterCompletion(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	if err := store.Put("gateway.bootstrap.password", "one-time-bootstrap-password"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", "one-time-bootstrap-password"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.jwtSecret", strings.Repeat("j", 64)); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("GATEWAY_JWT_SECRET", strings.Repeat("j", 64)); err != nil {
		t.Fatal(err)
	}
	before, err := store.Environment()
	if err != nil || before.Values["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] != "one-time-bootstrap-password" {
		t.Fatalf("pre-completion environment binding mismatch: err=%v", err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	after, err := store.Environment()
	if err != nil {
		t.Fatal(err)
	}
	if _, present := after.Values["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"]; present {
		t.Fatal("completed host environment still contains bootstrap password")
	}
	if after.Values["GATEWAY_JWT_SECRET"] != strings.Repeat("j", 64) {
		t.Fatal("completion removed an unrelated Gateway secret")
	}
	if password, present, err := store.Get("gateway.bootstrap.password"); err != nil || !present || password != "one-time-bootstrap-password" {
		t.Fatalf("completion deleted stored bootstrap secret: present=%v err=%v", present, err)
	}
}

// case: S-222.11
func TestBootstrapDisclosureAtomicallyErasesPasswordAndRejectsReinsertion(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	const password = "bootstrap-disclosure-test-sentinel"
	for name, value := range map[string]string{
		"gateway.bootstrap.password": password,
		BootstrapPasswordEnvironment: password,
		"gateway.jwtSecret":          "unrelated-secret",
	} {
		if err := store.Put(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	data := recordBytes(t, root)
	disclosed, err := store.BootstrapDisclosed()
	if err != nil || !disclosed || strings.Contains(string(data), password) || !strings.Contains(string(data), "unrelated-secret") {
		t.Fatal("disclosure update did not atomically preserve unrelated values, record the marker, and erase the password")
	}
	for _, name := range []string{"gateway.bootstrap.password", BootstrapPasswordEnvironment} {
		if present, err := store.Exists(name); err != nil || present {
			t.Fatalf("disclosed password key %q present=%v, err=%v", name, present, err)
		}
	}
	for _, name := range []string{BootstrapPassword, BootstrapPasswordEnvironment} {
		if err := store.Put(name, password); err != ErrBootstrapPasswordDisclosed {
			t.Fatalf("password reinsertion error for %q = %v; want ErrBootstrapPasswordDisclosed", name, err)
		}
	}
	if err := store.Put("gateway.bootstrap.disclosed", "false"); err != nil {
		t.Fatal("generic values remain separate from the bootstrap lifecycle record")
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || !disclosed {
		t.Fatal("generic storage changed the typed disclosure fact")
	}
}

func TestDisclosureStateAndPasswordDeletionShareOneAtomicRecord(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	const password = "interrupted-disclosure-test-sentinel"
	if err := store.PutBootstrapPassword(password, BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || !disclosed {
		t.Fatal("atomic secret record did not observe disclosure")
	}
	stored := recordBytes(t, root)
	if strings.Contains(string(stored), password) {
		t.Fatal("atomic handoff record retained a disclosed password")
	}
	if err := store.PutBootstrapPassword("replacement-after-disclosure", BootstrapOriginSupplied); !errors.Is(err, ErrBootstrapCredentialLocked) {
		t.Fatal("completed disclosed bootstrap did not refuse a credential replacement with its locked-state error")
	}
	afterRefusal := recordBytes(t, root)
	if !bytes.Equal(stored, afterRefusal) {
		t.Fatal("refused post-disclosure replacement changed the atomic state record")
	}
}

// case: S-222.13
func TestGenericRequirementNamesCannotWriteBootstrapLifecycleFacts(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	for _, id := range []string{"gateway.bootstrap.generated", "gateway.bootstrap.disclosed", "gateway.bootstrap.completed"} {
		if err := store.Put(id, "operator-value"); err != nil {
			t.Fatal(err)
		}
	}
	origin, present, err := store.BootstrapOrigin()
	if err != nil || present || origin != "" {
		t.Fatal("generic requirement write changed bootstrap origin")
	}
	disclosed, err := store.BootstrapDisclosed()
	if err != nil || disclosed {
		t.Fatal("generic requirement write changed bootstrap disclosure state")
	}
	completed, err := store.BootstrapCompleted()
	if err != nil || completed {
		t.Fatal("generic requirement write changed bootstrap completion state")
	}
}

// case: S-222.13
func TestLegacyFlatBootstrapMarkersReturnUnsupportedFormatWithoutReset(t *testing.T) {
	root := t.TempDir()
	store := Store{PlatformRoot: root}
	legacyDir := ""
	store.atomicWrite = func(path string, _ []byte, _ os.FileMode) error {
		legacyDir = filepath.Dir(path)
		return nil
	}
	if err := store.Put("fixture", "value"); err != nil {
		t.Fatal("resolve typed state location through the writer")
	}
	if err := os.MkdirAll(legacyDir, 0o750); err != nil {
		t.Fatal(err)
	}
	legacyFiles := map[string][]byte{
		filepath.Join(legacyDir, "secrets.env"):              []byte("gateway.bootstrap.generated=true\n" + BootstrapPassword + "=sentinel\n"),
		filepath.Join(legacyDir, "bootstrap-lifecycle.json"): []byte(`{"bootstrapPasswordOrigin":"generated"}`),
	}
	for path, data := range legacyFiles {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := store.Get(BootstrapPassword); !errors.Is(err, ErrUnsupportedSecretStoreFormat) {
		t.Fatal("previous flat and sidecar stores were not rejected with the unsupported-format diagnosis")
	}
	for path, data := range legacyFiles {
		after, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(after, data) {
			t.Fatal("unsupported old store was silently reset or changed")
		}
	}
}

func TestStoreUsesSharedCataloguedDiagnosisForInvalidWireFormat(t *testing.T) {
	for name, contents := range map[string][]byte{
		"unknown schema": []byte(`{"schema":99,"requirements":{},"bootstrap":{}}`),
		"malformed":      []byte(`{"schema":`),
	} {
		t.Run(name, func(t *testing.T) {
			store := Store{PlatformRoot: t.TempDir()}
			store.atomicWrite = func(path string, _ []byte, mode os.FileMode) error {
				if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
					return err
				}
				return os.WriteFile(path, contents, mode)
			}
			if err := store.Put("fixture", "value"); err != nil {
				t.Fatal(err)
			}
			_, _, err := store.Get("OTHER_SECRET")
			if !errors.Is(err, ErrUnsupportedSecretStoreFormat) {
				t.Fatalf("store error does not identify unsupported format: %v", err)
			}
			var failure *diag.Diag
			if !errors.As(err, &failure) || failure.Code != secretstate.UnsupportedCode {
				t.Fatalf("store diagnosis = %#v", failure)
			}
			catalog, ok := diag.LookupCatalog(secretstate.UnsupportedCode)
			if !ok || failure.Message != catalog.Message || failure.Hint != catalog.Hint {
				t.Fatalf("store diagnosis = %#v; catalog = %#v", failure, catalog)
			}
		})
	}
}

func TestBindEnvironmentsRejectsConflictingValuesForOneVariable(t *testing.T) {
	store := Store{PlatformRoot: t.TempDir()}
	_ = store.Put("a.secret", "one")
	_ = store.Put("b.secret", "two")
	patches := []contracts.ConfigPatch{
		{Owner: "manifest:a.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
		{Owner: "manifest:b.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
	}
	if err := store.BindEnvironments(patches); err == nil {
		t.Fatal("two different values for one environment variable must be rejected, not silently last-write-wins")
	}
	_ = store.Put("b.secret", "one")
	if err := store.BindEnvironments(patches); err != nil {
		t.Fatalf("identical values are not a conflict: %v", err)
	}
}
