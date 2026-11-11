//go:build darwin || linux

package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func worktreeLeasePath(root, worktree string) string {
	absolute, _ := filepath.Abs(filepath.Clean(worktree))
	digest := sha256.Sum256([]byte(absolute))
	return filepath.Join(root, "logs", "runner", "worktree-leases", fmt.Sprintf("%x.lock", digest))
}

func tryExclusiveWorktreeLease(path string) (*proc.FileLease, bool, error) {
	return proc.AcquireFileLease(path, proc.LeaseExclusiveTry)
}

func runnerWorktreeLeasePaths(workdir string) ([]string, error) {
	root := os.Getenv("KBLABS_WORKTREES_ROOT")
	if root == "" {
		return nil, nil
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve configured worktree root for process lease: %w", err)
	}
	workdir, err = filepath.EvalSymlinks(workdir)
	if err != nil {
		return nil, fmt.Errorf("resolve process workdir for lease: %w", err)
	}
	if !withinRoot(root, workdir) {
		return nil, nil
	}
	toplevel, err := exec.Command("git", "-C", workdir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return nil, nil
	}
	toplevelPath, err := filepath.EvalSymlinks(strings.TrimSpace(string(toplevel)))
	if err != nil {
		return nil, fmt.Errorf("resolve Git worktree for process lease: %w", err)
	}
	if toplevelPath != workdir {
		return nil, nil
	}
	branch, err := exec.Command("git", "-C", workdir, "symbolic-ref", "--quiet", "--short", "HEAD").Output()
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(branch)), "agent/") {
		return nil, nil
	}
	return []string{worktreeLeasePath(root, workdir)}, nil
}
