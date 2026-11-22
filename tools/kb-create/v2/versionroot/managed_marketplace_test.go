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
			packageID: map[string]any{"source": source, "version": "1.0.0", "integrity": "sha512-fixture", "resolvedPath": resolvedPath, "enabled": enabled, "marketplaceSource": selectedSource, "signatureStatus": "unsigned"},
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

// case: S-269.10
func TestManagedMarketplaceCoreGraphAcceptsRealInstallVariantsAndRequiresModulesMetadata(t *testing.T) {
	for _, test := range []struct {
		name, request, source, oldVersion, installedVersion string
		binAsFile, omitModules, invalidModules, wantError   bool
	}{
		{name: "unversioned-npm-install-with-pnpm-file-shims", request: "@kb-labs/sample", source: "npm", installedVersion: "1.2.3", binAsFile: true},
		{name: "npm-update-of-existing-adapter", request: "@kb-labs/sample", source: "npm", oldVersion: "1.0.0", installedVersion: "2.0.0"},
		{name: "registry-adapter-without-package-json-dependency", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3"},
		{name: "missing-pnpm-modules-metadata", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", omitModules: true, wantError: true},
		{name: "invalid-pnpm-modules-metadata", request: "@kb-labs/sample@1.2.3", source: "registry", installedVersion: "1.2.3", invalidModules: true, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			active := filepath.Join(t.TempDir(), "active")
			candidate := filepath.Join(t.TempDir(), "candidate")
			if test.oldVersion != "" {
				seedManagedGraphFixture(t, active, "@kb-labs/sample@"+test.oldVersion, "npm", test.oldVersion, false, false, false)
			} else {
				seedManagedGraphFixture(t, active, "", "", "", false, false, false)
			}
			seedManagedGraphFixture(t, candidate, test.request, test.source, test.installedVersion, test.binAsFile, test.omitModules, test.invalidModules)
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

func seedManagedGraphFixture(t *testing.T, root, adapterSpec, marketplaceSource, installedVersion string, binAsFile, omitModules, invalidModules bool) {
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
	for name, version := range dependencies {
		fmt.Fprintf(&lock, "      '%s':\n        specifier: %s\n", name, version)
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
		if err := os.WriteFile(entry, []byte("#!/usr/bin/env node\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		linkPath := filepath.Join(root, "node_modules", ".bin", executable.command)
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if binAsFile {
			shim := "#!/bin/sh\n# cmd-shim-target=" + entry + "\nexec node \"$0\" \"$@\"\n"
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
		lockEntry := map[string]any{"source": "marketplace", "version": installedVersion, "integrity": "sha512-fixture", "resolvedPath": filepath.ToSlash(filepath.Join("node_modules", filepath.FromSlash(name))), "enabled": true, "marketplaceSource": marketplaceSource, "signatureStatus": "unsigned"}
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
			script := `if(process.argv[2]==="--managed-generation-mutation-env-refs"){process.stdout.write(JSON.stringify({schema:1,environment:["KB_TEST_REGISTRY_TOKEN"]})+"\n");process.exit(0);}let body="";process.stdin.on("data",b=>body+=b);process.stdin.on("end",()=>{const envelope=JSON.parse(body);const r=envelope.mutation;if(process.argv[2]!=="--managed-generation-mutation"||r.operation!=="install"||process.env.KB_PLATFORM_ROOT!==process.cwd()||Object.hasOwn(process.env,"KB_TEST_REGISTRY_TOKEN")||envelope.environment.KB_TEST_REGISTRY_TOKEN!=="fixture-secret")process.exit(31);const result=JSON.stringify({schema:1,operation:"install",installed:[{requestedSpec:"@kb-labs/example@1.0.0",packageId:"@kb-labs/example",version:"1.0.0",resolvedVersion:"1.0.0",primaryKind:"adapter"}]})+"\n";if(` + strconv.Itoa(helperExit) + `===19)process.exit(19);if(` + strconv.Itoa(helperExit) + `===20){process.stdout.write(result);return;}const fs=require("node:fs");fs.mkdirSync("node_modules/@kb-labs/example",{recursive:true});fs.writeFileSync("node_modules/@kb-labs/example/package.json",JSON.stringify({name:"@kb-labs/example",version:"1.0.0",kb:{adapter:{manifest:"manifest.mjs"}}}));fs.writeFileSync("node_modules/@kb-labs/example/manifest.mjs","export const manifest = {};");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));pkg.dependencies["@kb-labs/example"]="1.0.0";fs.writeFileSync("package.json",JSON.stringify(pkg));fs.writeFileSync("pnpm-lock.yaml","lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n      '@kb-labs/example':\n        specifier: 1.0.0\n");fs.writeFileSync(".kb/marketplace.lock",JSON.stringify({schema:"kb.marketplace/3",plugins:{},adapters:{"@kb-labs/example":{source:"marketplace",version:"1.0.0",integrity:"sha256-test",resolvedPath:"node_modules/@kb-labs/example",enabled:true,marketplaceSource:"npm",signatureStatus:"unsigned"}}}));fs.writeFileSync("mutation.marker","staged");process.stdout.write(result);});`
			if err := os.WriteFile(helper, []byte(script), 0o600); err != nil {
				t.Fatal(err)
			}

			_, err := layout.RunManagedMarketplaceMutation(context.Background(), active, ManagedMarketplaceMutation{
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
	if err := os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n"), 0o600); err != nil {
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
		if err := os.WriteFile(entry, []byte("#!/usr/bin/env node\n"), 0o700); err != nil {
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
