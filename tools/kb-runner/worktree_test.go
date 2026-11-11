//go:build darwin || linux

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.126
func TestWorktreeEnsureIsSharedByCommandAndScheduler(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	worktrees := filepath.Join(root, "worktrees")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	calls := filepath.Join(t.TempDir(), "git.calls")
	fakeGit := `#!/bin/sh
selected=""
if [ "$1" = "-C" ]; then selected="$2"; shift 2; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then printf '%s\n' "${selected:-$FAKE_REPO}"; exit 0; fi
printf '%s\n' "$*" >> "$FAKE_GIT_CALLS"
case "$1" in
  check-ref-format) exit 0 ;;
  worktree) [ "$2" = "add" ] && mkdir -p "$5" ;;
  rev-parse) printf '%s\n' "$selected" ;;
  *) exit 91 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(fakeGit), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_REPO", repo)
	t.Setenv("FAKE_WORKDIR", filepath.Join(worktrees, "stream-a"))
	t.Setenv("FAKE_GIT_CALLS", calls)
	var output, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"worktree", "ensure", "stream-a", "--base", "main", "--workdir", filepath.Join(worktrees, "stream-a")}, &output, &stderr)
	if status.Code() != 0 {
		t.Fatalf("worktree ensure exit=%d stdout=%s stderr=%s", status.Code(), output.String(), stderr.String())
	}
	options := newSchedulerRunOptions(newSchedulerStore(t.TempDir()), schedulerRunOptionsConfig{})
	if err := options.ensureWorktree(SchedulerTask{RepoRoot: repo, Workdir: filepath.Join(worktrees, "stream-a"), Stream: "stream-a", Base: "main"}); err != nil {
		t.Fatalf("scheduler ensure: %v", err)
	}
	data, err := os.ReadFile(calls)
	if err != nil || strings.Count(string(data), "worktree add -B agent/stream-a") != 1 {
		t.Fatalf("worktree creation calls=%q err=%v", data, err)
	}
}
