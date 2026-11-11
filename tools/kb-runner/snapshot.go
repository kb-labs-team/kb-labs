//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func snapshotWorktree(stateIO runnerStateStore, worktree, stream string) (sha gitObjectID, ref string, resultErr error) {
	status, err := schedulerCommandOutput(worktree, "git", "-C", worktree, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return "", "", fmt.Errorf("inspect worktree before snapshot: %w", err)
	}
	unmerged, err := schedulerCommandOutput(worktree, "git", "-C", worktree, "ls-files", "-u")
	if err != nil {
		return "", "", fmt.Errorf("inspect unresolved index entries before snapshot: %w", err)
	}
	if unmerged != "" {
		return "", "", fmt.Errorf("cannot snapshot a worktree with unresolved merge entries; inspect the paths with: git -C %s diff --name-only --diff-filter=U", shellQuote(worktree))
	}
	head, err := readGitObjectIDCommand(worktree, "-C", worktree, "rev-parse", "HEAD")
	if err != nil {
		return "", "", fmt.Errorf("resolve worktree HEAD for snapshot: %w", err)
	}
	if status == "" {
		return head, "", nil
	}
	index, err := os.CreateTemp("", "kb-runner-snapshot-index-*")
	if err != nil {
		return "", "", fmt.Errorf("create private snapshot index: %w", err)
	}
	indexPath := index.Name()
	if err := index.Close(); err != nil {
		removeErr := os.Remove(indexPath)
		return "", "", errors.Join(fmt.Errorf("close private snapshot index: %w", err), removeErr)
	}
	defer func() {
		if err := os.Remove(indexPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove private snapshot index %s: %w", indexPath, err))
		}
	}()
	if _, err := gitWithIndex(stateIO, worktree, indexPath, "read-tree", "HEAD"); err != nil {
		return "", "", fmt.Errorf("initialize private snapshot index: %w", err)
	}
	if _, err := gitWithIndex(stateIO, worktree, indexPath, "add", "-A"); err != nil {
		return "", "", fmt.Errorf("stage worktree into private snapshot index: %w", err)
	}
	tree, err := gitWithIndexObjectID(stateIO, worktree, indexPath, "write-tree")
	if err != nil {
		return "", "", fmt.Errorf("write private snapshot tree: %w", err)
	}
	sha, err = readGitObjectIDMutation(stateIO, worktree, nil, "commit-tree", tree.String(), "-p", head.String(), "-m", "snapshot "+stream+" before agent round")
	if err != nil {
		return "", "", fmt.Errorf("create snapshot commit object: %w", err)
	}
	ref = filepath.ToSlash(filepath.Join("refs", "snapshots", stream, time.Now().UTC().Format("20060102T150405.000000000Z")))
	if _, err := stateIO.GitMutation(worktree, nil, "update-ref", ref, sha.String(), ""); err != nil {
		return "", "", fmt.Errorf("record snapshot ref %s: %w", ref, err)
	}
	return sha, ref, nil
}

func treeSHAForCommit(worktree, sha string) (gitObjectID, error) {
	commitID, err := storedGitObjectID(sha)
	if err != nil {
		return "", fmt.Errorf("commit SHA %q is invalid: %w", sha, err)
	}
	tree, err := readGitObjectIDCommand(worktree, "-C", worktree, "rev-parse", commitID.String()+"^{tree}")
	if err != nil {
		return "", fmt.Errorf("resolve tree for commit %s: %w", sha, err)
	}
	return tree, nil
}

func gitWithIndexObjectID(stateIO runnerStateStore, worktree, indexPath string, args ...string) (gitObjectID, error) {
	output, err := stateIO.GitMutation(worktree, []string{"GIT_INDEX_FILE=" + indexPath}, args...)
	if err != nil {
		return "", fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(output), err)
	}
	return readGitObjectID(output)
}

func gitWithIndex(stateIO runnerStateStore, worktree, indexPath string, args ...string) (string, error) {
	output, err := stateIO.GitMutation(worktree, []string{"GIT_INDEX_FILE=" + indexPath}, args...)
	if err != nil {
		return "", fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(output), err)
	}
	return strings.TrimSpace(output), nil
}
