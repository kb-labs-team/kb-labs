package artifacts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/contracts"
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
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:4873"})
	var output bytes.Buffer
	if err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry}).Run(context.Background(), &output, "pnpm", "--version"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "product-pnpm-ok") {
		t.Fatalf("output %q", output.String())
	}
	if _, err := os.Stat(filepath.Join(root, "corepack", "v1", "pnpm", toolchain.SupportedPnpm, "bin", "pnpm.cjs")); err != nil {
		t.Fatal(err)
	}
}

// case: PC-001.2, S-285.9, S-285.18
func TestProductCorepackProvisionFailureNamesSource(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	const knownSecret = "known secret with spaces"
	script := "#!/bin/sh\nprintf '%8192s' x >&2\nprintf '\\ncorepack-fixture: registry unavailable TOKEN=synthetic-secret-sentinel\\n' >&2\nprintf '%s' '{\"access_' >&2\nsleep 0.02\nprintf '%s' 'token\":\"pattern-secret-sentinel\"}' >&2\nprintf '%s' ' known secret with ' >&2\nsleep 0.02\nprintf '%s\\n' 'spaces' >&2\nexit 47\n"
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:1", Redactions: []string{knownSecret}})
	var transcript bytes.Buffer
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry, redactions: p.config.Redactions}).Run(context.Background(), &transcript, "pnpm", "--version")
	if err == nil || !strings.Contains(err.Error(), toolchain.SupportedPnpm) || !strings.Contains(err.Error(), "Corepack's default npm registry") || strings.Contains(err.Error(), p.config.Registry) || strings.Contains(err.Error(), "workspace root") {
		t.Fatalf("diagnostic = %v", err)
	}
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeApplyFailed ||
		failure.Meta["packageManagerExitCode"] != "47" {
		t.Fatalf("Corepack provisioning details = %#v", err)
	}
	stderrTail := fmt.Sprint(failure.Meta["packageManagerStderrTail"])
	for _, secret := range []string{"synthetic-secret-sentinel", "pattern-secret-sentinel", knownSecret} {
		if strings.Contains(stderrTail, secret) || strings.Contains(transcript.String(), secret) {
			t.Fatalf("Corepack output leaked %q: tail=%q transcript=%q", secret, stderrTail, transcript.String())
		}
	}
	for _, evidence := range []string{"corepack-fixture: registry unavailable", `access_token`, `[REDACTED]`} {
		if !strings.Contains(stderrTail, evidence) || !strings.Contains(transcript.String(), evidence) {
			t.Fatalf("safe Corepack evidence %q missing: tail=%q transcript=%q", evidence, stderrTail, transcript.String())
		}
	}
	if len(stderrTail) > externalCommandStderrTailBytes {
		t.Fatalf("Corepack stderr evidence exceeds tail limit: %d", len(stderrTail))
	}
}

func TestProductCorepackHomeAndRegistryAreShared(t *testing.T) {
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: t.TempDir(), Registry: "http://127.0.0.1:4873"})
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
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root})
	want := "npm_config_devdir=" + filepath.Join(root, "node-gyp")
	for _, item := range p.packageManagerEnvironment() {
		if item == want {
			return
		}
	}
	t.Fatalf("package manager environment lacks %q", want)
}

func TestCorepackStdoutFailureIsRedactedAndRetainedInTranscript(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "corepack"), []byte("#!/bin/sh\nprintf 'HTTP 404 fixture registry TOKEN=stdout-secret-sentinel\\n'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := mustPnpm(t, PnpmConfig{PackageManagerRoot: root, Registry: "http://127.0.0.1:1"})
	var transcript bytes.Buffer
	err := (CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.config.Registry}).Run(context.Background(), &transcript, "pnpm", "--version")
	var failure *diag.Diag
	if !errors.As(err, &failure) || strings.Contains(failure.Cause, "stdout-secret-sentinel") ||
		!strings.Contains(transcript.String(), "HTTP 404 fixture registry") || !strings.Contains(transcript.String(), `TOKEN="[REDACTED]"`) ||
		strings.Contains(transcript.String(), "stdout-secret-sentinel") {
		t.Fatalf("failure = %#v", err)
	}
}
