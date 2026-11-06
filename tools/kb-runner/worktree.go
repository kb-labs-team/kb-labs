//go:build darwin || linux

package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func worktreeCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	if len(args) == 0 || args[0] != "ensure" {
		return 2, fmt.Errorf("%s worktree: usage: %s worktree ensure <stream> --base <branch>; next: %s --help", root.Name(), root.Name(), root.InvocationCommand())
	}
	fs := flag.NewFlagSet("worktree ensure", flag.ContinueOnError)
	fs.SetOutput(errOut)
	base := fs.String("base", "", "base branch")
	workdir := fs.String("workdir", "", "persisted worktree path")
	parseArgs := args[1:]
	streamArg := ""
	if len(parseArgs) > 0 && parseArgs[0] != "" && parseArgs[0][0] != '-' {
		streamArg = parseArgs[0]
		parseArgs = parseArgs[1:]
	}
	if err := fs.Parse(parseArgs); err != nil {
		return 2, fmt.Errorf("%s worktree ensure: %w; next: %s worktree --help", root.Name(), err, root.InvocationCommand())
	}
	if streamArg == "" && len(fs.Args()) == 1 {
		streamArg = fs.Arg(0)
	}
	if streamArg == "" || len(fs.Args()) > 0 && fs.Args()[0] != streamArg || *base == "" {
		return 2, fmt.Errorf("%s worktree ensure: one stream and --base are required; next: %s worktree ensure --help", root.Name(), root.InvocationCommand())
	}
	stream := streamArg
	if err := validateSchedulerKey(stream, "stream"); err != nil {
		return 2, fmt.Errorf("%s worktree ensure: %w", root.Name(), err)
	}
	repoRoot, err := schedulerCommandOutput("", "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return 1, fmt.Errorf("%s worktree ensure: resolve repository root: %w", root.Name(), err)
	}
	repoRoot, err = filepath.Abs(repoRoot)
	if err != nil {
		return 1, fmt.Errorf("%s worktree ensure: resolve repository path: %w", root.Name(), err)
	}
	if *workdir == "" {
		*workdir = filepath.Join(filepath.Dir(repoRoot), stream)
	}
	*workdir, err = filepath.Abs(*workdir)
	if err != nil {
		return 1, fmt.Errorf("%s worktree ensure: resolve worktree path: %w", root.Name(), err)
	}
	if err := ensureGitWorktree(repoRoot, *workdir, stream, *base); err != nil {
		return 1, fmt.Errorf("%s worktree ensure: %w; next: %s worktree ensure %s --base %s", root.Name(), err, root.InvocationCommand(), stream, *base)
	}
	_, err = fmt.Fprintln(out, *workdir)
	return 0, err
}

func ensureGitWorktree(repoRoot, workdir, stream, base string) error {
	if _, err := os.Stat(workdir); os.IsNotExist(err) {
		branch := "agent/" + stream
		if _, err := schedulerCommandOutput(repoRoot, "git", "check-ref-format", "--branch", branch); err != nil {
			return fmt.Errorf("stream %q cannot form a Git worktree branch: %w", stream, err)
		}
		if err := os.MkdirAll(filepath.Dir(workdir), 0o700); err != nil {
			return fmt.Errorf("create worktree parent: %w", err)
		}
		if _, err := schedulerCommandOutput("", "git", "-C", repoRoot, "worktree", "add", "-B", branch, workdir, base); err != nil {
			return fmt.Errorf("create worktree for base %s: %w", base, err)
		}
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect workdir %s: %w", workdir, err)
	}
	resolved, err := schedulerCommandOutput(workdir, "git", "-C", workdir, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("workdir exists but is not a Git worktree: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return fmt.Errorf("resolve existing Git worktree path: %w", err)
	}
	if resolved != workdir {
		return fmt.Errorf("workdir resolves to %s, expected %s", resolved, workdir)
	}
	return nil
}
