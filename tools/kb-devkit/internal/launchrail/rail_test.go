package launchrail

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWorkspaceUsesOnlyDeclaredProcessLaunchOwners(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve launchrail test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", "..", ".."))
	findings, err := Check(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("workspace process setup outside declared launch owners: %+v", findings)
	}
}

func TestCheckFindsReintroducedProcessGroupSetupOutsideOwner(t *testing.T) {
	root := t.TempDir()
	owners := Owners()
	for _, owner := range owners {
		writeGoFile(t, root, filepath.Join(owner, "launch.go"), `package launch
var attrs = SysProcAttr{Setpgid: true}
`)
	}
	writeGoFile(t, root, "tools/kb-dev/internal/process/spawn.go", `package process
func start() { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
`)

	findings, err := Check(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].File != filepath.Join("tools", "kb-dev", "internal", "process", "spawn.go") || findings[0].Name != "Setpgid" {
		t.Fatalf("findings = %#v, want the reintroduced kb-dev Setpgid only", findings)
	}
}

func TestCheckFindsJobObjectCallsOutsideOwner(t *testing.T) {
	root := t.TempDir()
	writeGoFile(t, root, "tools/kb-env/start.go", `package main
func start() { windows.CreateJobObject(nil, nil) }
`)

	findings, err := Check(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Name != "CreateJobObject" {
		t.Fatalf("findings = %#v, want CreateJobObject", findings)
	}
}

func writeGoFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
