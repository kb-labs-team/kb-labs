//go:build !windows

package host

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

// case: S-269.10
func TestManagedAdapterInstallSharesPlatformWriterLock(t *testing.T) {
	root := filepath.Join(t.TempDir(), "managed-install")
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	writeReceipt(t, root, &contracts.HostSpec{Command: fakeHostBinary})
	active, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}

	// Acquire through the same host state API used by kb-create's platform
	// lifecycle writers, then verify the Marketplace mutation cannot stage or
	// activate a candidate concurrently.
	state, err := StateForRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	release, err := state.AcquireOperation("platform-writer-test")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	_, err = layout.RunManagedMarketplaceMutation(context.Background(), active, versionroot.ManagedMarketplaceMutation{
		Operation: versionroot.ManagedMarketplaceInstall,
		Specs:     []string{"@kb-labs/sample-adapter@2.0.0"},
	})
	if err == nil || !strings.Contains(err.Error(), "acquire installation operation lock") {
		t.Fatalf("managed adapter install error = %v; want refusal on the platform writer lock", err)
	}
	if selected, activeErr := layout.Active(); activeErr != nil || filepath.Clean(selected) != filepath.Clean(active) {
		t.Fatalf("active generation after lock refusal = %q, %v; want %s", selected, activeErr, active)
	}
	entries, err := os.ReadDir(layout.VersionsDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("generation entries after lock refusal = %v; want only the active generation", entries)
	}
}

// case: S-269.10
func TestLiveHostAndActiveGenerationSurviveFailedManagedAdapterInstall(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js 24 is required by the installed Marketplace helper")
	}
	version, err := exec.Command("node", "--version").Output()
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(version)), "v24.") {
		t.Skipf("Node.js 24 is required by the installed Marketplace helper (found %q)", strings.TrimSpace(string(version)))
	}

	root := filepath.Join(t.TempDir(), "managed-install")
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	writeReceipt(t, root, &contracts.HostSpec{
		Command:             fakeHostBinary,
		Args:                []string{"-port", fmt.Sprint(port)},
		HealthURL:           fmt.Sprintf("http://127.0.0.1:%d/health", port),
		ReadyTimeoutSeconds: 10,
		StopGraceSeconds:    3,
	})
	active, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	seedLiveHostMarketplaceFixture(t, active, layout)
	configureFailedManagedAdapterInstall(t, active, layout)

	runner, err := NewRunner(root)
	if err != nil {
		t.Fatal(err)
	}
	info, err := startProcessForTest(t, runner, context.Background())
	if err != nil {
		t.Fatalf("start disposable installed-shaped host: %v", err)
	}
	before, err := runner.Status(context.Background())
	if err != nil || before.State != StateRunning || !before.Healthy || before.PID != info.PID || filepath.Clean(before.TreeRoot) != filepath.Clean(active) {
		t.Fatalf("disposable host before install = %+v, %v; want healthy PID %d on %s", before, err, info.PID, active)
	}

	_, installErr := layout.RunManagedMarketplaceMutation(context.Background(), active, versionroot.ManagedMarketplaceMutation{
		Operation: versionroot.ManagedMarketplaceInstall,
		Specs:     []string{"@kb-labs/sample-adapter@2.0.0"},
	})
	if installErr == nil || !strings.Contains(installErr.Error(), "KB_MARKETPLACE_INSTALL_FAILED") {
		t.Fatalf("managed adapter install error = %v; want the fixture's typed package-manager failure", installErr)
	}
	if marker, readErr := os.ReadFile(filepath.Join(contracts.PackageManagerStateDirectory(root), "corepack", "failed-live-host-install.marker")); readErr != nil || string(marker) != "partial graph mutation reached" {
		t.Fatalf("fixture pnpm did not reach the candidate partial-mutation point: %q, %v", marker, readErr)
	}

	selected, err := layout.Active()
	if err != nil || filepath.Clean(selected) != filepath.Clean(active) {
		t.Fatalf("active generation after failed install = %q, %v; want original %s", selected, err, active)
	}
	for relative, expected := range map[string]string{
		"package.json":               `{"name":"kb-platform-live-fixture","version":"1.0.0","dependencies":{"@kb-labs/cli-bin":"1.0.0","@kb-labs/host-app":"1.0.0"}}`,
		"pnpm-lock.yaml":             liveFixtureLock,
		"node_modules/.modules.yaml": "layoutVersion: 5\nstoreDir: /fixture/pnpm-store\nvirtualStoreDir: .pnpm\n",
		".kb/marketplace.lock":       `{"schema":"kb.marketplace/3","plugins":{},"adapters":{}}`,
		"node_modules/.bin/kb":       "#!/bin/sh\nprintf '%s\\n' '1.0.0'\n",
		"node_modules/.bin/kb-host":  "#!/bin/sh\nprintf '%s\\n' '1.0.0'\n",
	} {
		got, readErr := os.ReadFile(filepath.Join(active, filepath.FromSlash(relative)))
		if readErr != nil || string(got) != expected {
			t.Fatalf("active %s after failed install = %q, %v; want original fixture bytes", relative, got, readErr)
		}
	}
	if output, err := exec.Command(filepath.Join(active, "node_modules", ".bin", "kb"), "--version").CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "1.0.0" {
		t.Fatalf("active CLI projection after failed install = %q, %v", output, err)
	}
	if output, err := exec.Command(filepath.Join(active, "node_modules", ".bin", "kb-host"), "--version").CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "1.0.0" {
		t.Fatalf("active host projection after failed install = %q, %v", output, err)
	}

	after, err := runner.Status(context.Background())
	if err != nil || after.State != StateRunning || !after.Healthy || after.PID != before.PID || filepath.Clean(after.TreeRoot) != filepath.Clean(active) {
		t.Fatalf("disposable host after failed install = %+v, %v; want same healthy process/root as before", after, err)
	}
}

const liveFixtureLock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@kb-labs/cli-bin':\n        specifier: 1.0.0\n        version: 1.0.0\n      '@kb-labs/host-app':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  '@kb-labs/cli-bin@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\n  '@kb-labs/host-app@1.0.0': {resolution: {integrity: sha512-Zml4dHVyZQ==}}\nsnapshots:\n  '@kb-labs/cli-bin@1.0.0': {}\n  '@kb-labs/host-app@1.0.0': {}\n"

func seedLiveHostMarketplaceFixture(t *testing.T, root string, layout versionroot.Layout) {
	t.Helper()
	files := map[string]string{
		"package.json":               `{"name":"kb-platform-live-fixture","version":"1.0.0","dependencies":{"@kb-labs/cli-bin":"1.0.0","@kb-labs/host-app":"1.0.0"}}`,
		"pnpm-lock.yaml":             liveFixtureLock,
		"node_modules/.modules.yaml": "layoutVersion: 5\nstoreDir: /fixture/pnpm-store\nvirtualStoreDir: .pnpm\n",
		".kb/marketplace.lock":       `{"schema":"kb.marketplace/3","plugins":{},"adapters":{}}`,
		".kb/kb.config.jsonc":        `{"marketplace":{"sources":[{"kind":"npm","url":"https://registry.invalid"}]}}`,
	}
	for relative, data := range files {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "node_modules", ".pnpm"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ packageID, binName string }{{"@kb-labs/cli-bin", "kb"}, {"@kb-labs/host-app", "kb-host"}} {
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(item.packageID))
		binPath := filepath.Join(packageRoot, "dist", "bin.js")
		if err := os.MkdirAll(filepath.Dir(binPath), 0o700); err != nil {
			t.Fatal(err)
		}
		packageData, _ := json.Marshal(map[string]any{"name": item.packageID, "version": "1.0.0", "bin": map[string]string{item.binName: "dist/bin.js"}})
		if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), packageData, 0o600); err != nil {
			t.Fatal(err)
		}
		bin := filepath.Join(root, "node_modules", ".bin", item.binName)
		if err := os.MkdirAll(filepath.Dir(bin), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf '%s\\n' '1.0.0'\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	packageManager := contracts.PackageManagerStateDirectory(layout.Root)
	corepackHome := filepath.Join(packageManager, "corepack")
	if err := os.MkdirAll(corepackHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(layout.SharedStateDir(), "cache"), 0o700); err != nil {
		t.Fatal(err)
	}
}

func configureFailedManagedAdapterInstall(t *testing.T, active string, layout versionroot.Layout) {
	t.Helper()
	corepackHome := filepath.Join(contracts.PackageManagerStateDirectory(layout.Root), "corepack")
	pnpmScript := filepath.Join(corepackHome, "v1", "pnpm", "11.4.0", "bin", "pnpm.cjs")
	if err := os.MkdirAll(filepath.Dir(pnpmScript), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pnpmScript, []byte(`const fs=require("node:fs");const path=require("node:path");if(process.argv.includes("--fixture-fail-after-partial-mutation")){const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));pkg.dependencies["@kb-labs/sample-adapter"]="^2.0.0";fs.writeFileSync("package.json",JSON.stringify(pkg));fs.writeFileSync("pnpm-lock.yaml","lockfileVersion: '9.0'\nimporters: {}\n");fs.rmSync("node_modules/.modules.yaml",{force:true});fs.rmSync("node_modules/.bin/kb",{force:true});fs.rmSync("node_modules/.bin/kb-host",{force:true});fs.writeFileSync(path.join(process.env.COREPACK_HOME,"failed-live-host-install.marker"),"partial graph mutation reached");process.stderr.write("fixture pnpm failed after candidate graph mutation\n");process.exit(42);}process.exit(31);`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "package.json"), []byte(`{"name":"@kb-labs/marketplace-app","kb":{"managedGenerationMutation":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := `if(process.argv[2]==="--managed-generation-mutation-env-refs"){process.stdout.write(JSON.stringify({schema:1,environment:[]})+"\n");process.exit(0);}const cp=require("node:child_process");let request="";process.stdin.on("data",b=>request+=b);process.stdin.on("end",()=>{const envelope=JSON.parse(request);if(envelope.mutation.operation!=="install")process.exit(31);const result=cp.spawnSync("pnpm",["--fixture-fail-after-partial-mutation"],{encoding:"utf8"});if(result.status!==0){process.stderr.write(JSON.stringify({schema:1,code:"KB_MARKETPLACE_INSTALL_FAILED",message:"The staged package graph could not be completed.",hint:"Retry the install after checking registry access."})+"\n");process.exit(1);}process.exit(32);});`
	helperPath := filepath.Join(active, "node_modules", "@kb-labs", "marketplace-app", "dist", "bin.js")
	if err := os.WriteFile(helperPath, []byte(helper+"\n// --managed-generation-mutation --managed-generation-mutation-env-refs\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
