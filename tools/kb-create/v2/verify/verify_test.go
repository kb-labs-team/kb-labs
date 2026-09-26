package verify

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

func planIn(t *testing.T, root string, host *contracts.HostSpec) contracts.ResolvedInstallPlan {
	t.Helper()
	return contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Request: contracts.InstallRequest{PlatformRoot: root}, Host: host}
}

func writeConfig(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func hostCode(err error) string {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return ""
}

func TestRunRecordsConfigDigestAndHostEndpoint(t *testing.T) {
	root := t.TempDir()
	writeConfig(t, root)
	spec := &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}
	check, err := Run(planIn(t, root, spec), time.Unix(7, 0))
	if err != nil {
		t.Fatal(err)
	}
	if check.ConfigSHA256 == "" || check.HostHealthURL != spec.HealthURL || !check.ReadinessCheckedAt.Equal(time.Unix(7, 0)) {
		t.Fatalf("verification = %#v", check)
	}
}

func TestRunRejectsMissingConfig(t *testing.T) {
	spec := &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}
	if _, err := Run(planIn(t, t.TempDir(), spec), time.Now()); err == nil {
		t.Fatal("a plan without generated config must not verify")
	}
}

func TestRunRejectsAPlanWithoutAValidHost(t *testing.T) {
	root := t.TempDir()
	writeConfig(t, root)
	if _, err := Run(planIn(t, root, nil), time.Now()); hostCode(err) != contracts.CodeHostSpecInvalid {
		t.Fatalf("no host: %v", err)
	}
	remote := &contracts.HostSpec{Command: "kb-host", HealthURL: "http://example.com:4000/health"}
	if _, err := Run(planIn(t, root, remote), time.Now()); hostCode(err) != contracts.CodeHostSpecInvalid {
		t.Fatalf("non-loopback host: %v", err)
	}
}
