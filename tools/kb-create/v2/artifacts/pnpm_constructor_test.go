package artifacts

import (
	"errors"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

func TestNewPnpmRejectsMissingRequiredInputs(t *testing.T) {
	config := PnpmConfig{
		Root:               t.TempDir(),
		CacheRoot:          t.TempDir(),
		PackageManagerRoot: t.TempDir(),
		Registry:           "https://registry.test",
		ReleaseCatalog:     testReleaseCatalog(t),
	}
	tests := []struct {
		name   string
		change func(*PnpmConfig)
		code   string
	}{
		{name: "root", change: func(config *PnpmConfig) { config.Root = "" }, code: contracts.CodeApplyFailed},
		{name: "cache root", change: func(config *PnpmConfig) { config.CacheRoot = "" }, code: contracts.CodeApplyFailed},
		{name: "package manager root", change: func(config *PnpmConfig) { config.PackageManagerRoot = "" }, code: contracts.CodeApplyFailed},
		{name: "release catalog", change: func(config *PnpmConfig) { config.ReleaseCatalog = catalog.Verified{} }, code: contracts.CodeReleaseIndexInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := config
			test.change(&candidate)
			_, err := NewPnpm(candidate)
			if err == nil {
				t.Fatal("NewPnpm accepted missing required configuration")
			}
			var diagnostic *diag.Diag
			if !errors.As(err, &diagnostic) || diagnostic.Code != test.code {
				t.Fatalf("NewPnpm error = %T %v, want diagnostic code %s", err, err, test.code)
			}
			if strings.Contains(diagnostic.Hint, "candidate preparation") || strings.Contains(diagnostic.Hint, "update command") ||
				diagnostic.Hint != "Correct the installer configuration and retry the operation that requested package installation." &&
					diagnostic.Hint != "Provide a valid sealed release index and retry the operation that requested package installation." &&
					diagnostic.Hint != "Provide a valid sealed previous release index and retry the operation that requested package installation." {
				t.Fatalf("constructor hint is not caller-neutral and actionable: %q", diagnostic.Hint)
			}
		})
	}
}

func TestNewPnpmAllowsImplicitRegistry(t *testing.T) {
	root := t.TempDir()
	_, err := NewPnpm(PnpmConfig{Root: root, CacheRoot: t.TempDir(), PackageManagerRoot: t.TempDir(),
		ReleaseCatalog: testReleaseCatalog(t)})
	if err != nil {
		t.Fatalf("NewPnpm rejected an implicit pnpm registry: %v", err)
	}
}
