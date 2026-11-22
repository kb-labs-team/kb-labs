package versionroot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/contracts"
	"gopkg.in/yaml.v3"
)

func TestManagedMarketplaceMutationExposesOnlyVerifiedAdapterInstall(t *testing.T) {
	for _, operation := range []ManagedMarketplaceOperation{"update", "uninstall", "enable", "disable"} {
		t.Run(string(operation), func(t *testing.T) {
			if err := validateManagedMarketplaceMutation(ManagedMarketplaceMutation{Operation: operation}); err == nil {
				t.Fatalf("unsupported operation %q was accepted", operation)
			}
		})
	}
	if err := validateManagedMarketplaceMutation(ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall}); err == nil {
		t.Fatal("empty adapter install was accepted")
	}
}

// case: S-269.12
func TestManagedMarketplaceMutationUsesExistingLifecycleLeaseWithoutReacquiring(t *testing.T) {
	layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
	lease, err := operationlock.Acquire(layout.OperationLockPath(), "apply")
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	_, err = layout.RunManagedMarketplaceMutationWithHeldLease(context.Background(), active, ManagedMarketplaceMutation{
		Operation: ManagedMarketplaceInstall,
		Specs:     []string{"@kb-labs/sample-plugin@1.0.0"},
	})
	if err == nil || strings.Contains(err.Error(), "operation already in progress") {
		t.Fatalf("lock-held Marketplace mutation error = %v; want a later helper/stage error, not a lock reacquire failure", err)
	}
	if operationlock.Held(layout.OperationLockPath()) != lease {
		t.Fatal("Marketplace mutation released or replaced the lifecycle lease")
	}
}

func TestMarketplaceCredentialChannelOnlyIncludesReferencedSafeVariables(t *testing.T) {
	values, err := marketplaceCredentialValues(
		[]string{"KB_REGISTRY_TOKEN", "MISSING_REGISTRY_TOKEN"},
		[]string{"KB_REGISTRY_TOKEN=fixture-secret", "NODE_OPTIONS=--require=unexpected", "HOME=/ambient"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values["KB_REGISTRY_TOKEN"] != "fixture-secret" {
		t.Fatalf("credential channel = %#v, want only referenced registry token", values)
	}
	for _, prohibited := range []string{"NODE_OPTIONS", "HOME", "PATH", "NPM_CONFIG_MODULES_DIR", "KB_PLATFORM_ROOT"} {
		if validMarketplaceCredentialName(prohibited) {
			t.Errorf("credential name %q should be prohibited", prohibited)
		}
	}
}

func TestManagedMarketplaceCredentialRefsComeOnlyFromConfiguredSourceCredentials(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{
  // Source URL interpolation must not grant process environment access.
  "marketplace": { "sources": [
    { "kind": "registry", "url": "https://${UNTRUSTED_URL}", "authToken": "${KB_REGISTRY_TOKEN}", "signingPublicKey": "${KB_SIGNING_KEY}" },
    { "kind": "npm", "url": "https://registry.example.test", "authToken": "${KB_REGISTRY_TOKEN}" }
  ] }
}`
	if err := os.WriteFile(filepath.Join(root, ".kb", "kb.config.jsonc"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	refs, err := managedMarketplaceCredentialRefs(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"KB_REGISTRY_TOKEN", "KB_SIGNING_KEY"}
	if !sameMarketplaceCredentialRefs(want, refs) {
		t.Fatalf("owner-derived credential refs = %v, want %v", refs, want)
	}
	if sameMarketplaceCredentialRefs(want, []string{"KB_REGISTRY_TOKEN", "KB_SIGNING_KEY", "UNTRUSTED_URL"}) {
		t.Fatal("helper-reported URL interpolation was accepted as an owner-approved credential")
	}
}

func TestManagedHelperFailureDiagnosticsAcceptOnlyBoundedTypedJSON(t *testing.T) {
	valid := decodeManagedHelperFailure([]byte(`{"schema":1,"code":"KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING","message":"pins missing","hint":"run update"}`))
	if valid == nil || !strings.Contains(valid.Error(), "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING") || !strings.Contains(valid.Error(), "run update") {
		t.Fatalf("typed helper diagnostic = %v", valid)
	}
	for _, invalid := range [][]byte{
		[]byte(`{"schema":1,"code":"bad code","message":"secret"}`),
		[]byte(`{"schema":1,"code":"KB_FAILURE","message":"message","stack":"raw"}`),
		[]byte(`{"schema":1,"code":"KB_FAILURE","message":"message"} {}`),
		[]byte(`{"schema":1,"code":"KB_FAILURE","message":"` + strings.Repeat("x", 2049) + `"}`),
	} {
		if err := decodeManagedHelperFailure(invalid); err != nil {
			t.Errorf("invalid diagnostic was accepted: %v", err)
		}
	}
}

func TestManagedMarketplacePostconditionRequiresValidEnabledAdapterAndManifest(t *testing.T) {
	stage := t.TempDir()
	packageID := "@kb-labs/postcondition-adapter"
	packageRoot := filepath.Join(stage, "node_modules", filepath.FromSlash(packageID))
	if err := os.MkdirAll(packageRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "manifest.mjs"), []byte("export const manifest = {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/postcondition-adapter","version":"1.0.0","kb":{"adapter":{"manifest":"manifest.mjs"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mutation := ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall, Specs: []string{packageID + "@1.0.0"}}
	result := managedMarketplaceInstallResult{Schema: 1, Operation: ManagedMarketplaceInstall, Installed: []managedMarketplaceInstallEntry{{RequestedSpec: packageID + "@1.0.0", PackageID: packageID, Version: "1.0.0", ResolvedVersion: "1.0.0", PrimaryKind: "adapter"}}}
	lockPath := filepath.Join(stage, ".kb", "marketplace.lock")
	writeLock := func(source string, enabled bool, resolvedPath string, marketplaceSource ...string) {
		t.Helper()
		selectedSource := "npm"
		if len(marketplaceSource) > 0 {
			selectedSource = marketplaceSource[0]
		}
		if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(map[string]any{"schema": "kb.marketplace/3", "plugins": map[string]any{}, "adapters": map[string]any{
			packageID: map[string]any{"source": source, "version": "1.0.0", "integrity": "sha512-Zml4dHVyZQ==", "resolvedPath": resolvedPath, "enabled": enabled, "marketplaceSource": selectedSource, "signatureStatus": "unsigned"},
		}})
		if err := os.WriteFile(lockPath, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeLock("marketplace", true, filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID))))
	if err := verifyManagedMarketplaceInstall(stage, mutation, result); err != nil {
		t.Fatalf("valid adapter postcondition was rejected: %v", err)
	}
	writeLock("marketplace", true, filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID))), "registry")
	if err := verifyManagedMarketplaceInstall(stage, mutation, result); err != nil {
		t.Fatalf("valid Registry adapter postcondition was rejected: %v", err)
	}
	for _, test := range []struct {
		name, source string
		enabled      bool
		resolvedPath string
	}{
		{"wrong-source", "local", true, filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID)))},
		{"disabled", "marketplace", false, filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID)))},
		{"missing-manifest", "marketplace", true, filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID)))},
		{"escaping-package", "marketplace", true, "../../outside"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.name == "missing-manifest" {
				if err := os.Remove(filepath.Join(packageRoot, "manifest.mjs")); err != nil {
					t.Fatal(err)
				}
			} else if _, err := os.Stat(filepath.Join(packageRoot, "manifest.mjs")); os.IsNotExist(err) {
				if err := os.WriteFile(filepath.Join(packageRoot, "manifest.mjs"), []byte("export const manifest = {};\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			writeLock(test.source, test.enabled, test.resolvedPath)
			if err := verifyManagedMarketplaceInstall(stage, mutation, result); err == nil {
				t.Fatal("invalid adapter postcondition was accepted")
			}
		})
	}
}

// case: S-269.12
func TestManagedMarketplacePostconditionAcceptsPluginAndBuildsMarketplaceInstallResult(t *testing.T) {
	stage := t.TempDir()
	packageID := "@kb-labs/postcondition-plugin"
	packageRoot := filepath.Join(stage, "node_modules", filepath.FromSlash(packageID))
	if err := os.MkdirAll(packageRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "manifest.mjs"), []byte("export const manifest = {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/postcondition-plugin","version":"2.0.0","kb":{"manifest":"manifest.mjs"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mutation := ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall, Specs: []string{packageID + "@2.0.0"}}
	result := managedMarketplaceInstallResult{
		Schema: 1, Operation: ManagedMarketplaceInstall,
		Installed: []managedMarketplaceInstallEntry{{RequestedSpec: packageID + "@2.0.0", PackageID: packageID, Version: "2.0.0", ResolvedVersion: "2.0.0", PrimaryKind: "plugin"}},
	}
	lockPath := filepath.Join(stage, ".kb", "marketplace.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatal(err)
	}
	lock, _ := json.Marshal(map[string]any{
		"schema": "kb.marketplace/3",
		"plugins": map[string]any{packageID: map[string]any{
			"source": "marketplace", "package": packageID, "version": "2.0.0", "integrity": "sha512-Zml4dHVyZQ==",
			"primaryKind": "plugin", "provides": []string{"plugin", "cli-command"}, "resolvedPath": filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(packageID))),
			"enabled": true, "marketplaceSource": "registry", "signatureStatus": "verified",
		}},
		"adapters": map[string]any{},
	})
	if err := os.WriteFile(lockPath, lock, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyManagedMarketplaceInstall(stage, mutation, result); err != nil {
		t.Fatalf("valid plugin postcondition was rejected: %v", err)
	}
	entries, err := managedMarketplaceAPIEntries(stage, result)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Spec != packageID+"@2.0.0" || entries[0].ID != packageID || entries[0].PrimaryKind != "plugin" ||
		entries[0].Provides[1] != "cli-command" || entries[0].PackageRoot != filepath.Join("node_modules", filepath.FromSlash(packageID)) ||
		entries[0].Scope != "platform" || entries[0].Source != "registry" || entries[0].SignatureStatus != "verified" {
		t.Fatalf("managed plugin API result = %#v", entries)
	}
}

// case: S-269.10
func TestManagedMarketplaceCoreGraphAcceptsRealInstallVariantsAndRequiresModulesMetadata(t *testing.T) {
	for _, test := range []struct {
		name, request, source, oldVersion, installedVersion                                                                  string
		binAsFile, omitModules, invalidModules, badResolved, missingResolved, omitLockGraph, invalidPackageRecord, wantError bool
	}{
		{name: "unversioned-npm-install-with-pnpm-file-shims", request: "@kb-labs/sample", source: "npm", installedVersion: "1.2.3", binAsFile: true},
		{name: "npm-update-of-existing-adapter", request: "@kb-labs/sample", source: "npm", oldVersion: "1.0.0", installedVersion: "2.0.0"},
		{name: "registry-adapter-without-package-json-dependency", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3"},
		{name: "missing-pnpm-modules-metadata", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", omitModules: true, wantError: true},
		{name: "invalid-pnpm-modules-metadata", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", invalidModules: true, wantError: true},
		{name: "missing-resolved-lock-version", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", missingResolved: true, wantError: true},
		{name: "incorrect-resolved-lock-version", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", badResolved: true, wantError: true},
		{name: "missing-pnpm-package-snapshot-graph", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", omitLockGraph: true, wantError: true},
		{name: "missing-pnpm-package-resolution", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", invalidPackageRecord: true, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			active := filepath.Join(t.TempDir(), "active")
			candidate := filepath.Join(t.TempDir(), "candidate")
			if test.oldVersion != "" {
				seedManagedGraphFixture(t, active, "@kb-labs/sample@"+test.oldVersion, "npm", test.oldVersion, false, false, false)
			} else {
				seedManagedGraphFixture(t, active, "", "", "", false, false, false)
			}
			seedManagedGraphFixture(t, candidate, test.request, test.source, test.installedVersion, test.binAsFile, test.omitModules, test.invalidModules, test.badResolved, test.missingResolved, test.omitLockGraph, test.invalidPackageRecord)
			mutation := ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall, Specs: []string{test.request}}
			result := managedMarketplaceInstallResult{Schema: 1, Operation: ManagedMarketplaceInstall, Installed: []managedMarketplaceInstallEntry{{RequestedSpec: test.request, PackageID: "@kb-labs/sample", Version: test.installedVersion, ResolvedVersion: test.installedVersion, PrimaryKind: "adapter"}}}
			err := verifyManagedMarketplaceCoreGraph(active, candidate, mutation, result)
			if test.wantError && err == nil {
				t.Fatal("invalid package-manager metadata was accepted")
			}
			if !test.wantError && err != nil {
				t.Fatalf("valid install variant was rejected: %v", err)
			}
		})
	}
}

func seedManagedGraphFixture(t *testing.T, root, adapterSpec, marketplaceSource, installedVersion string, binAsFile, omitModules, invalidModules bool, lockOptions ...bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "node_modules", ".pnpm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if !omitModules {
		modules := "layoutVersion: 5\nstoreDir: /tmp/pnpm-store\nvirtualStoreDir: .pnpm\n"
		if invalidModules {
			modules = "layoutVersion: 5\nvirtualStoreDir: .pnpm\n"
		}
		if err := os.WriteFile(filepath.Join(root, "node_modules", ".modules.yaml"), []byte(modules), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	dependencies := map[string]string{"@kb-labs/cli-bin": "1.0.0", "@kb-labs/host-app": "1.0.0"}
	if adapterSpec != "" && marketplaceSource == "npm" {
		name, _, _ := splitMarketplaceSpec(adapterSpec)
		dependencies[name] = "^" + installedVersion
	}
	manifest, _ := json.Marshal(map[string]any{"name": "managed-fixture", "version": "1.0.0", "dependencies": dependencies})
	if err := os.WriteFile(filepath.Join(root, "package.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	var lock strings.Builder
	lock.WriteString("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n")
	badResolved, missingResolved := false, false
	if len(lockOptions) > 0 {
		badResolved = lockOptions[0]
	}
	if len(lockOptions) > 1 {
		missingResolved = lockOptions[1]
	}
	omitLockGraph := len(lockOptions) > 2 && lockOptions[2]
	invalidPackageRecord := len(lockOptions) > 3 && lockOptions[3]
	lockEntries := map[string]bool{}
	for name, version := range dependencies {
		resolved := version
		if strings.HasPrefix(name, "@kb-labs/") && strings.Contains(name, "sample") {
			resolved = strings.TrimPrefix(version, "^")
		}
		if badResolved {
			resolved = "99.0.0"
		}
		fmt.Fprintf(&lock, "      '%s':\n        specifier: %s\n", name, version)
		if !missingResolved {
			fmt.Fprintf(&lock, "        version: %s\n", resolved)
		}
		lockEntries[name+"@"+resolved] = true
	}
	if !omitLockGraph {
		lock.WriteString("packages:\n")
		for key := range lockEntries {
			if invalidPackageRecord {
				fmt.Fprintf(&lock, "  '%s': {}\n", key)
			} else {
				fmt.Fprintf(&lock, "  '%s': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n", key)
			}
		}
		lock.WriteString("snapshots:\n")
		for key := range lockEntries {
			fmt.Fprintf(&lock, "  '%s': {}\n", key)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []struct{ name, command string }{{"@kb-labs/cli-bin", "kb"}, {"@kb-labs/host-app", "kb-host"}} {
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(executable.name))
		entry := filepath.Join(packageRoot, "dist", "bin.js")
		if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
			t.Fatal(err)
		}
		packageData, _ := json.Marshal(map[string]any{"name": executable.name, "version": "1.0.0", "bin": map[string]string{executable.command: "dist/bin.js"}})
		if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), packageData, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(entry, []byte("#!/bin/sh\nprintf '%s\\n' '1.0.0'\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		linkPath := filepath.Join(root, "node_modules", ".bin", executable.command)
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if binAsFile {
			shim := "#!/bin/sh\n# cmd-shim-target=" + entry + "\nexec node \"" + entry + "\" \"$@\"\n"
			if err := os.WriteFile(linkPath, []byte(shim), 0o700); err != nil {
				t.Fatal(err)
			}
		} else if err := os.Symlink(filepath.Join("..", filepath.FromSlash(executable.name), "dist", "bin.js"), linkPath); err != nil {
			t.Fatal(err)
		}
	}
	if adapterSpec != "" {
		name, _, _ := splitMarketplaceSpec(adapterSpec)
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(name))
		if err := os.MkdirAll(packageRoot, 0o700); err != nil {
			t.Fatal(err)
		}
		packageData, _ := json.Marshal(map[string]any{"name": name, "version": installedVersion, "kb": map[string]any{"adapter": map[string]any{"manifest": "manifest.mjs"}}})
		if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), packageData, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(packageRoot, "manifest.mjs"), []byte("export const manifest = {};\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o700); err != nil {
			t.Fatal(err)
		}
		lockEntry := map[string]any{"source": "marketplace", "version": installedVersion, "integrity": "sha512-Zml4dHVyZQ==", "resolvedPath": filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(name))), "enabled": true, "marketplaceSource": marketplaceSource, "signatureStatus": "unsigned"}
		data, _ := json.Marshal(map[string]any{"schema": "kb.marketplace/3", "plugins": map[string]any{}, "adapters": map[string]any{name: lockEntry}})
		if err := os.WriteFile(filepath.Join(root, ".kb", "marketplace.lock"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestManagedStageRetryCleansAtomicOwnerRegistrationTemporary(t *testing.T) {
	layout, _ := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
	stage, err := layout.StageManagedGeneration()
	if err != nil {
		t.Fatal(err)
	}
	temporary := layout.managedStageOwnerPath(stage) + ".tmp-interrupted"
	if err := os.WriteFile(temporary, []byte(`{"pid":`), 0o600); err != nil {
		t.Fatal(err)
	}
	lease, err := operationlock.Acquire(operationlock.Path(layout.HostStateDir()), "managed-stage-registration-test")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := layout.StageManagedGeneration()
	lease.Release()
	if err != nil {
		t.Fatalf("retry after interrupted atomic owner registration: %v", err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("orphan candidate remains after retry: %v", err)
	}
	if _, err := os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatalf("partial owner sidecar remains after retry: %v", err)
	}
	if err := layout.AbortManagedGeneration(retry); err != nil {
		t.Fatal(err)
	}
}

func TestManagedStageCleanupRefusesReusedProcessGroupIdentity(t *testing.T) {
	installRoot := t.TempDir()
	layout, err := New(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(layout.VersionsDir(), ".stage-managed-stale-owner")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	owner := managedStageOwner{PID: 7001, Identity: "original-start", StartedAt: time.Unix(100, 0)}
	ownerData, _ := json.Marshal(owner)
	if err := os.WriteFile(layout.managedStageOwnerPath(stage), ownerData, 0o600); err != nil {
		t.Fatal(err)
	}
	observer := reusedManagedStageObserver{
		root:    child.ProcessIdentity{PID: owner.PID, Identity: "reused-start", StartedAt: time.Unix(200, 0)},
		members: []child.ProcessMember{{PID: owner.PID, Identity: "reused-start"}},
	}
	signals := 0
	err = layout.stopManagedStageOwnerWith(stage, observer, func(child.ProcessObserver, child.ProcessIdentity, syscall.Signal) error {
		signals++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("cleanup error = %v, want fail-closed owner identity mismatch", err)
	}
	if signals != 0 {
		t.Fatalf("cleanup sent %d signals to a reused process group", signals)
	}
	if _, err := os.Stat(stage); err != nil {
		t.Fatalf("ambiguous candidate was deleted: %v", err)
	}
}

func TestManagedPnpmShimsRebaseAcrossStageAndActivationRename(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "versions", "active")
	stage := filepath.Join(root, "versions", ".stage-managed-123")
	target := filepath.Join(root, "versions", "managed-123")
	binDir := filepath.Join(stage, "node_modules", ".bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	nestedBin := filepath.Join(stage, "node_modules", "@kb-labs", "sample", "node_modules", ".bin")
	if err := os.MkdirAll(nestedBin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nestedBin, "nested"), []byte("#!/bin/sh\n# "+filepath.Join(active, "nested-target")+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "node_modules", ".modules.yaml"), []byte("layoutVersion: 5\nstoreDir: /tmp/store\nvirtualStoreDir: "+filepath.Join(active, "node_modules", ".pnpm")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(binDir, "kb-host")
	data := []byte("#!/bin/sh\n# cmd-shim-target=" + filepath.Join(active, "node_modules", "@kb-labs", "host-app", "dist", "bin.js") + "\n")
	if err := os.WriteFile(shim, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := rewriteManagedBinShimRoots(stage, []string{active}, stage); err != nil {
		t.Fatal(err)
	}
	stageData, err := os.ReadFile(shim)
	if err != nil || !strings.Contains(string(stageData), filepath.Join(stage, "node_modules")) || strings.Contains(string(stageData), active) {
		t.Fatalf("staged executable shim was not rebased: %s (%v)", stageData, err)
	}
	if err := os.Rename(stage, target); err != nil {
		t.Fatal(err)
	}
	if err := rewriteManagedBinShimRoots(target, []string{stage, active}, target); err != nil {
		t.Fatal(err)
	}
	targetData, err := os.ReadFile(filepath.Join(target, "node_modules", ".bin", "kb-host"))
	if err != nil || !strings.Contains(string(targetData), filepath.Join(target, "node_modules")) || strings.Contains(string(targetData), stage) || strings.Contains(string(targetData), active) {
		t.Fatalf("finalized executable shim was not rebased: %s (%v)", targetData, err)
	}
	nestedData, err := os.ReadFile(filepath.Join(target, "node_modules", "@kb-labs", "sample", "node_modules", ".bin", "nested"))
	if err != nil || !strings.Contains(string(nestedData), target) || strings.Contains(string(nestedData), stage) || strings.Contains(string(nestedData), active) {
		t.Fatalf("nested shim not rebased: %s (%v)", nestedData, err)
	}
	modulesData, err := os.ReadFile(filepath.Join(target, "node_modules", ".modules.yaml"))
	if err != nil || !strings.Contains(string(modulesData), filepath.Join(target, "node_modules", ".pnpm")) || strings.Contains(string(modulesData), stage) || strings.Contains(string(modulesData), active) {
		t.Fatalf("virtualStoreDir not rebased: %s (%v)", modulesData, err)
	}
}

func TestManagedExecutableProjectionRejectsShimThatDoesNotInvokeDeclaredBinary(t *testing.T) {
	root := t.TempDir()
	seedManagedGraphFixture(t, root, "", "", "", true, false, false)
	projection := filepath.Join(root, "node_modules", ".bin", "kb")
	target := filepath.Join(root, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.WriteFile(projection, []byte("#!/bin/sh\n# cmd-shim-target="+target+"\nexec node /bin/false \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedExecutableProjection(root, "@kb-labs/cli-bin"); err == nil {
		t.Fatal("broken launcher passed because its comment named the valid target")
	}
}

func TestManagedHostProjectionValidationDoesNotStartHost(t *testing.T) {
	root := t.TempDir()
	seedManagedGraphFixture(t, root, "", "", "", true, false, false)
	marker := filepath.Join(root, "host-started")
	entry := filepath.Join(root, "node_modules", "@kb-labs", "host-app", "dist", "bin.js")
	projection := filepath.Join(root, "node_modules", ".bin", "kb-host")
	if err := os.WriteFile(projection, []byte("#!/bin/sh\n# cmd-shim-target="+entry+"\nprintf started > '"+marker+"'\nexec node \""+entry+"\" \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("#!/bin/sh\nprintf started > '"+marker+"'\nprintf '1.0.0\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedExecutableProjection(root, "@kb-labs/host-app"); err != nil {
		t.Fatalf("safe non-executing host shim check failed: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("candidate shim code ran during validation: %v", err)
	}
}

func TestManagedMarketplaceRejectsDanglingFrozenLockTransitiveEdge(t *testing.T) {
	active := filepath.Join(t.TempDir(), "active")
	candidate := filepath.Join(t.TempDir(), "candidate")
	seedManagedGraphFixture(t, active, "", "", "", false, false, false)
	seedManagedGraphFixture(t, candidate, "@kb-labs/sample@1.2.3", "registry", "1.2.3", false, false, false)
	lock := "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n        version: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  '@kb-labs/cli-bin@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/host-app@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/sample@1.2.3': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\nsnapshots:\n  '@kb-labs/cli-bin@1.0.0':\n    dependencies:\n      '@kb-labs/missing': 1.0.0\n  '@kb-labs/host-app@1.0.0': {}\n  '@kb-labs/sample@1.2.3': {}\n"
	if err := os.WriteFile(filepath.Join(candidate, "pnpm-lock.yaml"), []byte(lock), 0o600); err != nil {
		t.Fatal(err)
	}
	mutation := ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall, Specs: []string{"@kb-labs/sample@1.2.3"}}
	result := managedMarketplaceInstallResult{Schema: 1, Operation: ManagedMarketplaceInstall, Installed: []managedMarketplaceInstallEntry{{RequestedSpec: "@kb-labs/sample@1.2.3", PackageID: "@kb-labs/sample", Version: "1.2.3", ResolvedVersion: "1.2.3", PrimaryKind: "adapter"}}}
	if err := verifyManagedMarketplaceCoreGraph(active, candidate, mutation, result); err == nil || !strings.Contains(err.Error(), "unresolved dependency") {
		t.Fatalf("dangling transitive lock edge was not rejected: %v", err)
	}
}

func TestManagedLockRequiresPeerAwareSnapshot(t *testing.T) {
	packages := map[string]any{"@kb-labs/sample@1.2.3": map[string]any{"resolution": map[string]any{"integrity": "sha512-Zml4dHVyZQ=="}}}
	snapshots := map[string]managedPnpmLockSnapshot{"@kb-labs/sample@1.2.3": {}}
	if managedLockEntriesExist(packages, snapshots, "@kb-labs/sample", "1.2.3(peer@2.0.0)") {
		t.Fatal("base snapshot incorrectly satisfied a peer-qualified lock resolution")
	}
	snapshots["@kb-labs/sample@1.2.3(peer@2.0.0)"] = managedPnpmLockSnapshot{}
	if !managedLockEntriesExist(packages, snapshots, "@kb-labs/sample", "1.2.3(peer@2.0.0)") {
		t.Fatal("matching peer-qualified snapshot was rejected")
	}
}

func TestManagedLockResolvesNpmAliasToUnderlyingPackage(t *testing.T) {
	root := t.TempDir()
	aliasRoot := filepath.Join(root, "node_modules", "string-width-cjs")
	if err := os.MkdirAll(aliasRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliasRoot, "package.json"), []byte(`{"name":"string-width","version":"4.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	specifier := "npm:string-width@^4.2.0"
	resolved := "string-width@4.2.3"
	if !managedLockVersionMatches(root, "string-width-cjs", specifier, resolved) {
		t.Fatal("valid npm alias importer resolution was rejected")
	}
	packages := map[string]any{"string-width@4.2.3": map[string]any{"resolution": map[string]any{"integrity": "sha512-Zml4dHVyZQ=="}}}
	snapshots := map[string]managedPnpmLockSnapshot{"string-width@4.2.3": {}}
	if !managedLockEntriesExist(packages, snapshots, "string-width-cjs", resolved) {
		t.Fatal("alias lock resolution did not use the underlying package identity")
	}
	if managedLockVersionMatches(root, "string-width-cjs", "npm:other-package@^4.2.0", resolved) {
		t.Fatal("alias resolved to a different package than the requested alias target")
	}
}

func TestManagedLockAcceptsPnpmGeneratedNpmAliasGraph(t *testing.T) {
	// This lock fixture was generated by pnpm 11.4.0 from a disposable
	// manifest declaring string-width-cjs: npm:string-width@4.2.3.
	lockData, err := os.ReadFile(filepath.Join("testdata", "pnpm-alias-lock.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Importers map[string]struct {
			Dependencies map[string]struct {
				Specifier string `yaml:"specifier"`
				Version   string `yaml:"version"`
			} `yaml:"dependencies"`
		} `yaml:"importers"`
		Packages  map[string]any                     `yaml:"packages"`
		Snapshots map[string]managedPnpmLockSnapshot `yaml:"snapshots"`
	}
	if err := yaml.Unmarshal(lockData, &lock); err != nil {
		t.Fatal(err)
	}
	dep := lock.Importers["."].Dependencies["string-width-cjs"]
	root := t.TempDir()
	aliasRoot := filepath.Join(root, "node_modules", "string-width-cjs")
	if err := os.MkdirAll(aliasRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliasRoot, "package.json"), []byte(`{"name":"string-width","version":"4.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !managedLockVersionMatches(root, "string-width-cjs", dep.Specifier, dep.Version) || !managedLockEntriesExist(lock.Packages, lock.Snapshots, "string-width-cjs", dep.Version) {
		t.Fatal("pnpm-generated npm alias importer did not resolve to its underlying package")
	}
	for key, snapshot := range lock.Snapshots {
		if !lockPackageExists(lock.Packages, strings.SplitN(key, "(", 2)[0]) {
			t.Fatalf("snapshot %q has no package resolution record", key)
		}
		for name, version := range snapshot.Dependencies {
			if !managedLockEntriesExist(lock.Packages, lock.Snapshots, name, version) {
				t.Fatalf("snapshot %q has unresolved dependency %q", key, name)
			}
		}
	}
}

type reusedManagedStageObserver struct {
	root    child.ProcessIdentity
	members []child.ProcessMember
}

func (o reusedManagedStageObserver) RootIdentity(pid int) (child.ProcessIdentity, error) {
	if pid != o.root.PID {
		return child.ProcessIdentity{}, fmt.Errorf("unexpected PID %d", pid)
	}
	return o.root, nil
}

func (o reusedManagedStageObserver) LiveMembers(int, child.ProcessIdentity) ([]child.ProcessMember, error) {
	return o.members, nil
}

// case: S-269.12
func TestManagedMarketplaceOwnerRunsInstalledHelperInCandidateAndSwitchesOnlyOnSuccess(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the installed-helper transaction test")
	}
	for _, helperExit := range []int{0, 19, 20} {
		t.Run(map[int]string{0: "success", 19: "failure", 20: "exit-zero-without-postcondition"}[helperExit], func(t *testing.T) {
			t.Setenv("KB_TEST_REGISTRY_TOKEN", "fixture-secret")
			layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
			if err := os.WriteFile(filepath.Join(active, ".kb", "kb.config.jsonc"), []byte(`{"marketplace":{"sources":[{"kind":"npm","url":"https://registry.example.test","authToken":"${KB_TEST_REGISTRY_TOKEN}"}]}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			installFakeManagedPnpm(t, layout)
			seedManagedCoreCommandGraph(t, active)
			if err := os.MkdirAll(filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "dist"), 0o700); err != nil {
				t.Fatal(err)
			}
			pkg := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "package.json")
			if err := os.WriteFile(pkg, []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			helper := filepath.Join(filepath.Dir(pkg), "dist", "bin.js")
			script := `if(process.argv[2]==="--managed-generation-mutation-env-refs"){process.stdout.write(JSON.stringify({schema:1,environment:["KB_TEST_REGISTRY_TOKEN"]})+"\n");process.exit(0);}let body="";process.stdin.on("data",b=>body+=b);process.stdin.on("end",()=>{const envelope=JSON.parse(body);const r=envelope.mutation;if(process.argv[2]!=="--managed-generation-mutation"||r.operation!=="install"||process.env.KB_PLATFORM_ROOT!==process.cwd()||Object.hasOwn(process.env,"KB_TEST_REGISTRY_TOKEN")||envelope.environment.KB_TEST_REGISTRY_TOKEN!=="fixture-secret")process.exit(31);const result=JSON.stringify({schema:1,operation:"install",installed:[{requestedSpec:"@kb-labs/example@1.0.0",packageId:"@kb-labs/example",version:"1.0.0",resolvedVersion:"1.0.0",primaryKind:"adapter"}]})+"\n";if(` + strconv.Itoa(helperExit) + `===19)process.exit(19);if(` + strconv.Itoa(helperExit) + `===20){process.stdout.write(result);return;}const fs=require("node:fs");fs.mkdirSync("node_modules/@kb-labs/example",{recursive:true});fs.writeFileSync("node_modules/@kb-labs/example/package.json",JSON.stringify({name:"@kb-labs/example",version:"1.0.0",kb:{adapter:{manifest:"manifest.mjs"}}}));fs.writeFileSync("node_modules/@kb-labs/example/manifest.mjs","export const manifest = {};");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));pkg.dependencies["@kb-labs/example"]="1.0.0";fs.writeFileSync("package.json",JSON.stringify(pkg));fs.writeFileSync("pnpm-lock.yaml","lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n        version: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n        version: 1.0.0\n      '@kb-labs/example':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  '@kb-labs/cli-bin@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/host-app@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/example@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\nsnapshots:\n  '@kb-labs/cli-bin@1.0.0': {}\n  '@kb-labs/host-app@1.0.0': {}\n  '@kb-labs/example@1.0.0': {}\n");fs.writeFileSync(".kb/marketplace.lock",JSON.stringify({schema:"kb.marketplace/3",plugins:{},adapters:{"@kb-labs/example":{source:"marketplace",version:"1.0.0",integrity:"sha256-test",resolvedPath:"node_modules/@kb-labs/example",enabled:true,marketplaceSource:"npm",signatureStatus:"unsigned"}}}));fs.writeFileSync("mutation.marker","staged");process.stdout.write(result);});`
			if err := os.WriteFile(helper, []byte(script), 0o600); err != nil {
				t.Fatal(err)
			}

			result, err := layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
				Operation: ManagedMarketplaceInstall,
				Specs:     []string{"@kb-labs/example@1.0.0"},
			})
			selected, activeErr := layout.Active()
			if activeErr != nil {
				t.Fatal(activeErr)
			}
			if helperExit != 0 {
				if err == nil {
					t.Fatal("helper without a verified package postcondition unexpectedly committed its candidate")
				}
				if selected != active {
					t.Fatalf("failed helper changed active generation: got %q want %q", selected, active)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Installed) != 1 || result.Scope != "platform" || result.Installed[0].Spec != "@kb-labs/example@1.0.0" ||
				result.Installed[0].ID != "@kb-labs/example" || result.Installed[0].PrimaryKind != "adapter" ||
				result.Installed[0].PackageRoot != filepath.Join(selected, "node_modules", "@kb-labs", "example") ||
				result.Installed[0].Source != "npm" || result.Installed[0].SignatureStatus != "unsigned" {
				t.Fatalf("managed Marketplace result = %#v; want Marketplace API install record under the activated generation", result)
			}
			if selected == active {
				t.Fatal("successful helper did not activate its candidate")
			}
			if data, readErr := os.ReadFile(filepath.Join(selected, "mutation.marker")); readErr != nil || string(data) != "staged" {
				t.Fatalf("candidate mutation = %q, %v", data, readErr)
			}
			if _, statErr := os.Stat(filepath.Join(active, "mutation.marker")); !os.IsNotExist(statErr) {
				t.Fatalf("helper mutated active generation: %v", statErr)
			}
		})
	}
}

// case: S-269.10
func TestManagedMarketplaceFailedPnpmMutationPreservesActiveGeneration(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the installed-helper transaction test")
	}
	layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
	seedManagedGraphFixture(t, active, "@kb-labs/sample@1.0.0", "npm", "1.0.0", false, false, false)
	if err := os.WriteFile(filepath.Join(active, ".kb", "kb.config.jsonc"), []byte(`{"marketplace":{"sources":[{"kind":"npm","url":"https://registry.example.test"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installFakeManagedPnpm(t, layout)
	pnpmScript := filepath.Join(contracts.PackageManagerStateDirectory(layout.Root), "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")
	pnpmFailure := `const fs=require("node:fs");if(process.argv.includes("--fixture-fail-after-partial-mutation")){const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));pkg.dependencies["@kb-labs/sample"]="^2.0.0";fs.writeFileSync("package.json",JSON.stringify(pkg));fs.writeFileSync("pnpm-lock.yaml","lockfileVersion: '9.0'\nimporters: {}\n");fs.writeFileSync("partial-pnpm-mutation.marker","written");fs.rmSync("node_modules/.modules.yaml",{force:true});fs.rmSync("node_modules/.bin/kb",{force:true});fs.rmSync("node_modules/.bin/kb-host",{force:true});fs.writeFileSync(require("node:path").join(process.env.COREPACK_HOME,"failed-pnpm-mutation.marker"),"partial graph mutation reached");process.stderr.write("simulated pnpm failure after mutating staged package graph\n");process.exit(42);}process.exit(31);`
	if err := os.WriteFile(pnpmScript, []byte(pnpmFailure), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app")
	if err := os.MkdirAll(filepath.Join(helper, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(helper, "package.json"), []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	helperScript := `if(process.argv[2]==="--managed-generation-mutation-env-refs"){process.stdout.write(JSON.stringify({schema:1,environment:[]})+"\n");process.exit(0);}const cp=require("node:child_process");let request="";process.stdin.on("data",b=>request+=b);process.stdin.on("end",()=>{const envelope=JSON.parse(request);if(envelope.mutation.operation!=="install")process.exit(31);const result=cp.spawnSync("pnpm",["--fixture-fail-after-partial-mutation"],{encoding:"utf8"});if(result.status!==0){process.stderr.write(JSON.stringify({schema:1,code:"KB_MARKETPLACE_INSTALL_FAILED",message:"The staged package graph could not be completed.",hint:"Retry the install after checking registry access."})+"\n");process.exit(1);}process.exit(32);});`
	helperEntry := filepath.Join(helper, "dist", "bin.js")
	if err := os.WriteFile(helperEntry, []byte(helperScript+"\n// --managed-generation-mutation capability\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := []string{"package.json", "pnpm-lock.yaml", "node_modules/.modules.yaml", ".kb/marketplace.lock", "node_modules/@kb-labs/sample/package.json", "node_modules/@kb-labs/sample/manifest.mjs", "node_modules/.bin/kb", "node_modules/.bin/kb-host"}
	snapshot := make(map[string]string, len(paths))
	for _, relative := range paths {
		path := filepath.Join(active, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatalf("active %s missing before update: %v", relative, err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read active %s before update: %v", relative, err)
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				t.Fatal(err)
			}
		}
		snapshot[relative] = fmt.Sprintf("%#o\x00%s\x00%s", info.Mode(), link, data)
	}

	_, err := layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
		Operation: ManagedMarketplaceInstall,
		Specs:     []string{"@kb-labs/sample@2.0.0"},
	})
	if err == nil || !strings.Contains(err.Error(), "KB_MARKETPLACE_INSTALL_FAILED") || !strings.Contains(err.Error(), "Retry the install after checking registry access.") {
		t.Fatalf("failed package-manager update error = %v; expected typed Marketplace failure with hint", err)
	}
	mutationMarker := filepath.Join(contracts.PackageManagerStateDirectory(layout.Root), "corepack", "failed-pnpm-mutation.marker")
	if marker, readErr := os.ReadFile(mutationMarker); readErr != nil || string(marker) != "partial graph mutation reached" {
		t.Fatalf("fixture pnpm did not reach its partial-mutation failure point: %q, %v", marker, readErr)
	}
	selected, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(selected) != filepath.Clean(active) {
		t.Fatalf("failed update changed active generation: got %q want %q", selected, active)
	}
	for _, relative := range paths {
		path := filepath.Join(active, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatalf("failed update damaged active %s: %v", relative, err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read active %s after update: %v", relative, err)
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				t.Fatal(err)
			}
		}
		got := fmt.Sprintf("%#o\x00%s\x00%s", info.Mode(), link, data)
		if got != snapshot[relative] {
			t.Fatalf("failed update changed active %s", relative)
		}
	}
	if err := verifyManagedMarketplaceCoreGraph(active, active, ManagedMarketplaceMutation{Operation: ManagedMarketplaceInstall}, managedMarketplaceInstallResult{Schema: 1, Operation: ManagedMarketplaceInstall}); err != nil {
		t.Fatalf("previous active package graph is no longer healthy after failed update: %v", err)
	}
	for _, command := range []string{"kb", "kb-host"} {
		probe := exec.Command(filepath.Join(active, "node_modules", ".bin", command), "--version")
		output, err := probe.CombinedOutput()
		if err != nil || strings.TrimSpace(string(output)) != "1.0.0" {
			t.Fatalf("previous %s projection stopped working after failed update: output=%q err=%v", command, output, err)
		}
	}
	entries, err := os.ReadDir(layout.VersionsDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".stage-managed-") {
			t.Fatalf("failed candidate was not cleaned: %s", entry.Name())
		}
	}
}

func TestManagedMarketplaceOwnerHardKillPreservesLiveCandidate(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("managed operation locking is supported on Linux and macOS")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for the subprocess lifecycle test")
	}
	if root := os.Getenv("KB_TEST_MANAGED_OWNER_ROOT"); root != "" {
		layout, err := New(root)
		if err != nil {
			os.Exit(61)
		}
		active, err := layout.Active()
		if err != nil {
			os.Exit(62)
		}
		_, err = layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
			Operation: ManagedMarketplaceInstall,
			Specs:     []string{"@kb-labs/example@1.0.0"},
		})
		if err != nil {
			os.Exit(63)
		}
		os.Exit(0)
	}

	layout, active := initialLayout(t, filepath.Join(t.TempDir(), "install"), "1.0.0")
	if err := os.WriteFile(filepath.Join(active, ".kb", "kb.config.jsonc"), []byte(`{"marketplace":{"sources":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installFakeManagedPnpm(t, layout)
	pnpmScript := filepath.Join(contracts.PackageManagerStateDirectory(layout.Root), "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")
	if err := os.WriteFile(pnpmScript, []byte(`const cp=require("node:child_process");const fs=require("node:fs");if(process.argv.includes("--fixture-long")){const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("pnpm-child.ready",String(child.pid));setInterval(()=>{},1000);}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app")
	if err := os.MkdirAll(filepath.Join(app, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "package.json"), []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	childScript := `if(process.argv[2]==="--managed-generation-mutation-env-refs"){process.stdout.write(JSON.stringify({schema:1,environment:[]})+"\n");process.exit(0);}const cp=require("node:child_process");const fs=require("node:fs");const envelope=JSON.parse(fs.readFileSync(0,"utf8"));if(envelope.mutation.operation!=="install")process.exit(31);const pm=cp.spawn("pnpm",["--fixture-long"],{stdio:"ignore"});pm.on("error",e=>fs.writeFileSync("pnpm-child.error",String(e)));const wait=()=>{if(fs.existsSync("pnpm-child.ready")){fs.writeFileSync("mutation.ready",fs.readFileSync("pnpm-child.ready"));setInterval(()=>{},1000);}else setTimeout(wait,10)};wait();`
	if err := os.WriteFile(filepath.Join(app, "dist", "bin.js"), []byte(childScript+"\n// --managed-generation-mutation capability\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	owner := exec.Command(os.Args[0], "-test.run=^TestManagedMarketplaceOwnerHardKillPreservesLiveCandidate$")
	owner.Env = append(os.Environ(), "KB_TEST_MANAGED_OWNER_ROOT="+layout.Root)
	owner.Stdout, owner.Stderr = nil, nil
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if owner.Process != nil {
			_ = owner.Process.Kill()
		}
	}()

	var stage, groupID string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(layout.VersionsDir())
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".stage-managed-") {
				candidate := filepath.Join(layout.VersionsDir(), entry.Name())
				if data, err := os.ReadFile(filepath.Join(candidate, "mutation.ready")); err == nil {
					stage, groupID = candidate, strings.TrimSpace(string(data))
					break
				}
			}
		}
		if stage != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if stage == "" || groupID == "" {
		_ = owner.Process.Kill()
		_, _ = owner.Process.Wait()
		entries, _ := os.ReadDir(layout.VersionsDir())
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".stage-managed-") {
				candidate := filepath.Join(layout.VersionsDir(), entry.Name())
				if data, err := os.ReadFile(filepath.Join(candidate, "pnpm-child.ready")); err == nil {
					pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
					if pid > 0 {
						_ = child.KillTree(pid)
					}
				}
				if data, err := os.ReadFile(filepath.Join(candidate, "pnpm-child.error")); err == nil {
					t.Fatalf("installed helper could not launch the fixture pnpm child: %s", strings.TrimSpace(string(data)))
				}
			}
		}
		t.Fatal("installed helper did not reach the candidate mutation stage")
	}
	ownerData, err := os.ReadFile(layout.managedStageOwnerPath(stage))
	if err != nil {
		t.Fatalf("helper ownership sidecar was not published before mutation: %v", err)
	}
	var stageOwner managedStageOwner
	if err := json.Unmarshal(ownerData, &stageOwner); err != nil || stageOwner.PID <= 0 || stageOwner.Identity == "" || stageOwner.StartedAt.IsZero() {
		t.Fatalf("published helper ownership sidecar is invalid: %v", err)
	}
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = owner.Process.Wait()
	owner.Process = nil

	lease, err := operationlock.Acquire(operationlock.Path(layout.HostStateDir()), "managed-stage-recovery-test")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := layout.StageManagedGeneration()
	lease.Release()
	if err != nil {
		t.Fatalf("bounded owner cleanup should terminate the abandoned helper and allow retry: %v", err)
	}
	pid, err := strconv.Atoi(groupID)
	if err != nil {
		t.Fatal(err)
	}
	identity := child.ProcessIdentity{PID: stageOwner.PID, Identity: stageOwner.Identity, StartedAt: stageOwner.StartedAt}
	if members, err := proc.ChildProcessObserver().LiveMembers(stageOwner.PID, identity); err != nil || len(members) != 0 {
		t.Fatalf("managed helper/package-manager process group rooted at %d (pnpm child %d) remains after cleanup: members=%v err=%v", stageOwner.PID, pid, members, err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("orphan candidate remains after its process group was stopped: %v", err)
	}
	if err := layout.AbortManagedGeneration(retry); err != nil {
		t.Fatal(err)
	}
}

func installFakeManagedPnpm(t *testing.T, layout Layout) {
	t.Helper()
	path := filepath.Join(contracts.PackageManagerStateDirectory(layout.Root), "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("process.stdout.write('pnpm-test-fixture')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func seedManagedCoreCommandGraph(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "node_modules", ".pnpm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", ".modules.yaml"), []byte("layoutVersion: 5\nstoreDir: /tmp/pnpm-store\nvirtualStoreDir: .pnpm\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"name":         "kb-platform-fixture",
		"version":      "1.0.0",
		"dependencies": map[string]string{"@kb-labs/cli-bin": "1.0.0", "@kb-labs/host-app": "1.0.0"},
	}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(root, "package.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n        version: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  '@kb-labs/cli-bin@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/host-app@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\nsnapshots:\n  '@kb-labs/cli-bin@1.0.0': {}\n  '@kb-labs/host-app@1.0.0': {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []struct{ name, command string }{{"@kb-labs/cli-bin", "kb"}, {"@kb-labs/host-app", "kb-host"}} {
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(executable.name))
		entry := filepath.Join(packageRoot, "dist", "bin.js")
		if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
			t.Fatal(err)
		}
		packageData, _ := json.Marshal(map[string]any{"name": executable.name, "version": "1.0.0", "bin": map[string]string{executable.command: "dist/bin.js"}})
		if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), packageData, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(entry, []byte("#!/bin/sh\nprintf '%s\\n' '1.0.0'\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		linkPath := filepath.Join(root, "node_modules", ".bin", executable.command)
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("..", filepath.FromSlash(executable.name), "dist", "bin.js"), linkPath); err != nil {
			t.Fatal(err)
		}
	}
}
