package artifacts

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/toolchain"
)

// case: S-285.9, S-284.20
func TestProductCorepackProvisionUsesInstallHomeAndRegistry(t *testing.T) {
	root := t.TempDir()
	bin := t.TempDir()
	script := `#!/bin/sh
set -eu
if [ "$1" = install ]; then
  [ "$COREPACK_NPM_REGISTRY" = "http://127.0.0.1:4874" ]
  [ "$2" = -g ] && [ "$3" = "pnpm@` + toolchain.SupportedPnpm + `" ]
  mkdir -p "$COREPACK_HOME/v1/pnpm/` + toolchain.SupportedPnpm + `/bin"
  printf 'import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; fs.writeFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "pnpm-native"), "fixture", { mode: 0o700 }); process.stdout.write("` + toolchain.SupportedPnpm + `")' > "$COREPACK_HOME/v1/pnpm/` + toolchain.SupportedPnpm + `/bin/pnpm.mjs"
elif [ "$1" = pnpm ] && [ "$2" = --version ]; then
  node "$COREPACK_HOME/v1/pnpm/` + toolchain.SupportedPnpm + `/bin/pnpm.mjs" --version
else
  exit 1
fi
`
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("COREPACK_NPM_REGISTRY", "http://127.0.0.1:4874")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:4873"})
	var output bytes.Buffer
	if err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry}).Run(context.Background(), &output, "pnpm", "--version"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), toolchain.SupportedPnpm) {
		t.Fatalf("output %q", output.String())
	}
	if _, err := os.Stat(filepath.Join(root, "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.mjs")); err != nil {
		t.Fatal(err)
	}
}

// case: S-285.9
func TestProductCorepackProvisionFailureNamesSource(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:1"})
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry}).Run(context.Background(), &bytes.Buffer{}, "pnpm", "--version")
	if err == nil || !strings.Contains(err.Error(), toolchain.SupportedPnpm) || !strings.Contains(err.Error(), "Corepack's default npm registry") || strings.Contains(err.Error(), p.config.Registry) || strings.Contains(err.Error(), "workspace root") {
		t.Fatalf("diagnostic = %v", err)
	}
}

func TestProductCorepackWrapperWithoutNativeBinaryFailsClearlyWhenOffline(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	marker := filepath.Join(t.TempDir(), "corepack-invoked")
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{
		Root: filepath.Join(root, "platform"), CacheRoot: filepath.Join(root, "cache"),
		PackageManagerRoot: filepath.Join(root, "package-manager"), Registry: "http://127.0.0.1:1", Offline: true,
	})
	script := filepath.Join(p.corepackHome(), "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.mjs")
	if err := os.MkdirAll(filepath.Dir(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("process.exit(0)"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.prepare(); err != nil {
		t.Fatal(err)
	}
	packageJSONBefore, err := os.ReadFile(filepath.Join(p.config.Root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	workspaceBefore, err := os.ReadFile(filepath.Join(p.config.Root, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	err = p.run("install")
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || !strings.Contains(diagnostic.Message, toolchain.SupportedPnpm) || !strings.Contains(diagnostic.Hint, "corepack pnpm --version") {
		t.Fatalf("offline missing-native diagnostic = %v", err)
	}
	if packageJSONAfter, readErr := os.ReadFile(filepath.Join(p.config.Root, "package.json")); readErr != nil || !bytes.Equal(packageJSONAfter, packageJSONBefore) {
		t.Fatalf("offline package operation changed package.json: err=%v", readErr)
	}
	if workspaceAfter, readErr := os.ReadFile(filepath.Join(p.config.Root, "pnpm-workspace.yaml")); readErr != nil || !bytes.Equal(workspaceAfter, workspaceBefore) {
		t.Fatalf("offline package operation changed pnpm-workspace.yaml: err=%v", readErr)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("offline probe invoked Corepack: stat marker err = %v", statErr)
	}
}

func TestProductCorepackHomeAndRegistryAreShared(t *testing.T) {
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: t.TempDir(), Registry: "http://127.0.0.1:4873"})
	env := strings.Join(p.packageManagerEnvironment(), "\n")
	if !strings.Contains(env, "COREPACK_HOME="+p.corepackHome()) || strings.Contains(env, "COREPACK_NPM_REGISTRY=") {
		t.Fatalf("Corepack environment = %s", env)
	}
	script := filepath.Join(p.corepackHome(), "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.mjs")
	if err := os.MkdirAll(filepath.Dir(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := toolchain.PnpmExecutableAt(p.corepackHome()); err == nil {
		t.Fatal("Corepack wrapper without native executable was accepted")
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(script)), "pnpm-native"), []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	_, resolved, err := toolchain.PnpmExecutableAt(p.corepackHome())
	if err != nil || resolved != script {
		t.Fatalf("resolved = %q, %v", resolved, err)
	}
}

// case: S-285.15
func TestNativeBuildCacheIsInsidePackageManagerRoot(t *testing.T) {
	root := t.TempDir()
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root})
	want := "npm_config_devdir=" + filepath.Join(root, "node-gyp")
	for _, item := range p.packageManagerEnvironment() {
		if item == want {
			return
		}
	}
	t.Fatalf("package manager environment lacks %q", want)
}

func TestCorepackStdoutFailureAppearsInProvisioningDiagnostic(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte("#!/bin/sh\nprintf 'HTTP 404 fixture registry\\n'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:1"})
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry}).Run(context.Background(), &bytes.Buffer{}, "pnpm", "--version")
	var failure *diag.Diag
	if !errors.As(err, &failure) || !strings.Contains(failure.Reason, "HTTP 404 fixture registry") || !strings.Contains(failure.Cause, "HTTP 404 fixture registry") {
		t.Fatalf("failure = %#v", err)
	}
}
