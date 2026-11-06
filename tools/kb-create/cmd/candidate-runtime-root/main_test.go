package main

import (
	"bytes"
	"log"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestCommandWritesRedactedFailureDossier(t *testing.T) {
	outputDir := t.TempDir()
	const sentinel = "candidate-test-secret-sentinel"
	t.Setenv("CANDIDATE_TEST_SECRET", sentinel)
	cmd := exec.Command("go", "run", ".", "--index", filepath.Join(t.TempDir(), sentinel), "--packages", t.TempDir(), "--root", t.TempDir(), "--registry", "http://127.0.0.1:1", "--diagnostics-dir", outputDir)
	if output, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("candidate unexpectedly succeeded: %s", output)
	}
	files, err := os.ReadDir(outputDir)
	if err != nil || len(files) != 1 {
		t.Fatalf("expected one diagnostic dossier, got %v, %v", files, err)
	}
	data, err := os.ReadFile(filepath.Join(outputDir, files[0].Name()))
	if err != nil || !strings.Contains(string(data), contracts.CodeReleaseIndexUnreadable) || strings.Contains(string(data), sentinel) {
		t.Fatalf("missing candidate diagnostic: %s, %v", data, err)
	}
}

func TestRegistryReportsMetadataEncodingFailure(t *testing.T) {
	var output bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	registry := &packageRegistry{packages: map[string]map[string]candidatePackage{
		"@kb-labs/broken": {
			"1.0.0": {Manifest: map[string]any{"unsupported": make(chan int)}},
		},
	}}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/@kb-labs/broken", nil)
	registry.ServeHTTP(response, request)

	if response.Code != 500 {
		t.Fatalf("expected HTTP 500 for unencodable package metadata, got %d", response.Code)
	}
	if !strings.Contains(output.String(), "encode candidate package metadata") {
		t.Fatalf("expected encoding failure in server log, got %q", output.String())
	}
}

func TestCandidatePackageInstallerUsesInstallRootPackageManagerState(t *testing.T) {
	layout := versionroot.Layout{Root: t.TempDir()}
	stage := filepath.Join(layout.Root, "versions", "candidate")
	const registryURL = "http://127.0.0.1:49183"
	installer, err := candidatePackageInstaller(layout, stage, registryURL)
	if err != nil {
		t.Fatal(err)
	}
	if installer.PackageManagerRoot != layout.PackageManagerStateDir() {
		t.Fatalf("package manager root = %q, want install-root state %q", installer.PackageManagerRoot, layout.PackageManagerStateDir())
	}
	if installer.Registry != registryURL {
		t.Fatalf("package manager registry = %q, want Compose registry %q", installer.Registry, registryURL)
	}
}
