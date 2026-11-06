//go:build darwin || linux

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.124
func TestVerifyOutsideIsolatesModulesAndReportsFailingTests(t *testing.T) {
	home := t.TempDir()
	worktree := "verify-fixture"
	root := filepath.Join(home, "Desktop", "work", "kb-labs-workspace-worktrees")
	for _, dir := range []string{
		filepath.Join(root, worktree, "tools", "kb-create", "pkg"),
		filepath.Join(root, worktree, "tools", "kb-create", "e2e", "install"),
		filepath.Join(root, worktree, "tools", "kb-create", "journey", "install"),
		filepath.Join(root, worktree, "tools", "clikit", "proc"),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	bin := t.TempDir()
	argsPath := filepath.Join(t.TempDir(), "go.args")
	envPath := filepath.Join(t.TempDir(), "go.env")
	outputPath := filepath.Join(t.TempDir(), "test-output.jsonl")
	if err := os.WriteFile(outputPath, []byte("{\"Action\":\"fail\",\"Package\":\"create/pkg\",\"Test\":\"TestApply\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeGo := `#!/bin/sh
case "$1" in
  env) printf '%s\n' /tmp/fake-gocache /tmp/fake-gomodcache ;;
  list)
    case "$PWD" in
      */kb-create) printf '{"ImportPath":"create/pkg","Dir":"%s/pkg"}\n{"ImportPath":"create/e2e/install","Dir":"%s/e2e/install"}\n{"ImportPath":"create/journey/install","Dir":"%s/journey/install"}\n' "$PWD" "$PWD" "$PWD" ;;
      */clikit) printf '{"ImportPath":"clikit/proc","Dir":"%s/proc"}\n' "$PWD" ;;
      *) exit 88 ;;
    esac
    ;;
  test)
    printf '%s|%s\n' "$PWD" "$*" >> "$FAKE_GO_ARGS"
    printf 'HOME=%s KB_PLATFORM_ROOT=%s KB_HOME=%s KB_NET_OFFSET=%s GOFLAGS=%s\n' "$HOME" "${KB_PLATFORM_ROOT-UNSET}" "${KB_HOME-UNSET}" "${KB_NET_OFFSET-UNSET}" "${GOFLAGS-UNSET}" >> "$FAKE_GO_ENV"
    case "$PWD" in */kb-create) cat "$FAKE_GO_TEST_OUTPUT"; exit 1 ;; *) exit 0 ;; esac
    ;;
  *) exit 89 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "go"), []byte(fakeGo), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KB_PLATFORM_ROOT", "/must/be/removed")
	t.Setenv("KB_HOME", "/must/be/removed")
	t.Setenv("KB_NET_OFFSET", "900")
	t.Setenv("GOFLAGS", "-tags=must-be-removed")
	t.Setenv("FAKE_GO_ARGS", argsPath)
	t.Setenv("FAKE_GO_ENV", envPath)
	t.Setenv("FAKE_GO_TEST_OUTPUT", outputPath)

	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"verify", "outside", worktree, "kb-create:./...", "clikit:./proc/...", "--json"}, &stdout, &stderr)
	if status.Code() != 0 {
		t.Fatalf("verify outside exit=%d stdout=%s stderr=%s", status.Code(), stdout.String(), stderr.String())
	}
	var result verifyOutsideResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode --json result: %v; output=%s", err, stdout.String())
	}
	if len(result.Modules) != 2 || result.Modules[0].Failures != 1 || len(result.Modules[0].FailedTests) != 1 || result.Modules[0].FailedTests[0].Test != "TestApply" || result.Modules[1].ExitCode != 0 {
		t.Fatalf("module result=%+v", result)
	}
	log := filepath.Join(root, "logs", worktree+".outside.kb-create.jsonl")
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if lines[len(lines)-1] != "exit=1" || !strings.Contains(string(data), `"Test":"TestApply"`) {
		t.Fatalf("outside JSONL=%q", data)
	}
	done, err := os.ReadFile(filepath.Join(root, "logs", worktree+".outside.done"))
	if err != nil || !strings.Contains(string(done), "kb-create fails=1 exit=1") || !strings.Contains(string(done), "clikit fails=0 exit=0") {
		t.Fatalf("done file=%q err=%v", done, err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil || strings.Contains(string(args), "create/e2e") || strings.Contains(string(args), "create/journey") || !strings.Contains(string(args), "create/pkg") {
		t.Fatalf("go test arguments=%q err=%v", args, err)
	}
	env, err := os.ReadFile(envPath)
	if err != nil || !strings.Contains(string(env), "KB_PLATFORM_ROOT=UNSET KB_HOME=UNSET KB_NET_OFFSET=UNSET GOFLAGS=UNSET") || !strings.Contains(string(env), "HOME="+home+string(os.PathSeparator)+"kb-runner-outside-") {
		t.Fatalf("isolated go environment=%q err=%v", env, err)
	}
}
