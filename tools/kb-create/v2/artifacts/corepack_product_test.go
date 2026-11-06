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
[ "$COREPACK_NPM_REGISTRY" = "http://127.0.0.1:4874" ]
[ "$1" = install ] && [ "$2" = -g ] && [ "$3" = "pnpm@` + toolchain.SupportedPnpm + `" ]
mkdir -p "$COREPACK_HOME/v1/pnpm/` + toolchain.SupportedPnpm + `/bin"
printf 'process.stdout.write("product-pnpm-ok")' > "$COREPACK_HOME/v1/pnpm/` + toolchain.SupportedPnpm + `/bin/pnpm.cjs"
`
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("COREPACK_NPM_REGISTRY", "http://127.0.0.1:4874")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := Pnpm{PackageManagerRoot: root, Registry: "http://127.0.0.1:4873"}
	var output bytes.Buffer
	if err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.Registry}).Run(context.Background(), &output, "pnpm", "--version"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "product-pnpm-ok") {
		t.Fatalf("output %q", output.String())
	}
	if _, err := os.Stat(filepath.Join(root, "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")); err != nil {
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
	p := Pnpm{PackageManagerRoot: root, Registry: "http://127.0.0.1:1"}
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.Registry}).Run(context.Background(), &bytes.Buffer{}, "pnpm", "--version")
	if err == nil || !strings.Contains(err.Error(), toolchain.SupportedPnpm) || !strings.Contains(err.Error(), "Corepack's default npm registry") || strings.Contains(err.Error(), p.Registry) || strings.Contains(err.Error(), "workspace root") {
		t.Fatalf("diagnostic = %v", err)
	}
}

func TestProductCorepackHomeAndRegistryAreShared(t *testing.T) {
	p := Pnpm{PackageManagerRoot: t.TempDir(), Registry: "http://127.0.0.1:4873"}
	env := strings.Join(p.packageManagerEnvironment(), "\n")
	if !strings.Contains(env, "COREPACK_HOME="+p.corepackHome()) || strings.Contains(env, "COREPACK_NPM_REGISTRY=") {
		t.Fatalf("Corepack environment = %s", env)
	}
	script := filepath.Join(p.corepackHome(), "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")
	if err := os.MkdirAll(filepath.Dir(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("fixture"), 0600); err != nil {
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
	p := Pnpm{PackageManagerRoot: root}
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
	p := Pnpm{PackageManagerRoot: root, Registry: "http://127.0.0.1:1"}
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.Registry}).Run(context.Background(), &bytes.Buffer{}, "pnpm", "--version")
	var failure *diag.Diag
	if !errors.As(err, &failure) || !strings.Contains(failure.Reason, "HTTP 404 fixture registry") || !strings.Contains(failure.Cause, "HTTP 404 fixture registry") {
		t.Fatalf("failure = %#v", err)
	}
}
