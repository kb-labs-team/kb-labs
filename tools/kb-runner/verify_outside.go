//go:build darwin || linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type verifyOutsideResult struct {
	Worktree string                      `json:"worktree"`
	Modules  []verifyOutsideModuleResult `json:"modules"`
}

type verifyOutsideModuleResult struct {
	Module      string                    `json:"module"`
	Log         string                    `json:"log"`
	ExitCode    int                       `json:"exit_code"`
	Failures    int                       `json:"failures"`
	FailedTests []verifyOutsideFailedTest `json:"failed_tests"`
}

type verifyOutsideFailedTest struct {
	Package string `json:"package"`
	Test    string `json:"test"`
}

type goPackage struct {
	ImportPath string
	Dir        string
}

func parseOutsideSuiteSpec(specification string) (string, string, error) {
	module, packages, ok := strings.Cut(specification, ":")
	if !ok || module == "" || packages == "" || strings.ContainsAny(module, "/\\\x00") || strings.ContainsAny(packages, "\x00") {
		return "", "", fmt.Errorf("outside suite %q must use module:packages", specification)
	}
	return module, packages, nil
}

func verifyCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	if len(args) == 0 || args[0] != "outside" {
		return 2, fmt.Errorf("%s verify: usage: %s verify outside <worktree> [module:pkgs…] [--json]; next: %s --help", root.Name(), root.Name(), root.InvocationCommand())
	}
	fs := flag.NewFlagSet("verify outside", flag.ContinueOnError)
	fs.SetOutput(errOut)
	jsonOutput := fs.Bool("json", false, "write machine-readable results")
	parseArgs := make([]string, 0, len(args)-1)
	for _, arg := range args[1:] {
		if arg == "--json" {
			*jsonOutput = true
			continue
		}
		parseArgs = append(parseArgs, arg)
	}
	if err := fs.Parse(parseArgs); err != nil {
		return 2, err
	}
	remaining := fs.Args()
	if len(remaining) == 0 {
		return 2, fmt.Errorf("%s verify outside: worktree is required; next: %s verify --help", root.Name(), root.InvocationCommand())
	}
	worktreeArg := remaining[0]
	modules := remaining[1:]
	if len(modules) == 0 {
		modules = []string{"clikit:./proc/...", "kb-runner:./..."}
	}
	next := root.InvocationCommand() + " verify outside " + shellQuote(worktreeArg)
	for _, module := range modules {
		next += " " + shellQuote(module)
	}
	if *jsonOutput {
		next += " --json"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return 1, fmt.Errorf("%s verify outside: resolve HOME: %w", root.Name(), err)
	}
	worktreesRoot := filepath.Join(home, "Desktop", "work", "kb-labs-workspace-worktrees")
	worktree := worktreeArg
	if !filepath.IsAbs(worktree) {
		worktree = filepath.Join(worktreesRoot, worktreeArg)
	}
	worktree, err = filepath.Abs(worktree)
	if err != nil {
		return 1, fmt.Errorf("%s verify outside: resolve worktree: %w", root.Name(), err)
	}
	name := filepath.Base(filepath.Clean(worktree))
	logsDir := filepath.Join(worktreesRoot, "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		return 1, fmt.Errorf("%s verify outside: create logs directory: %w", root.Name(), err)
	}
	donePath := filepath.Join(logsDir, name+".outside.done")
	if err := os.Remove(donePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return 1, fmt.Errorf("%s verify outside: clear previous done file: %w", root.Name(), err)
	}
	result := verifyOutsideResult{Worktree: worktree, Modules: make([]verifyOutsideModuleResult, 0, len(modules))}
	for _, specification := range modules {
		module, packages, err := parseOutsideSuiteSpec(specification)
		if err != nil {
			return 2, fmt.Errorf("%s verify outside: %w; next: %s verify --help", root.Name(), err, root.InvocationCommand())
		}
		moduleDir := filepath.Join(worktree, "tools", module)
		if err := verifyOutsideModule(moduleDir, packages, filepath.Join(logsDir, name+".outside."+strings.ReplaceAll(module, "/", "-")+".jsonl"), &result.Modules); err != nil {
			return 1, fmt.Errorf("%s verify outside: module %s: %w; next: %s", root.Name(), module, err, next)
		}
	}
	done := strings.Builder{}
	for _, module := range result.Modules {
		fmt.Fprintf(&done, "%s fails=%d exit=%d\n", module.Module, module.Failures, module.ExitCode)
	}
	if err := os.WriteFile(donePath, []byte(done.String()), 0o600); err != nil {
		return 1, fmt.Errorf("%s verify outside: write done file: %w", root.Name(), err)
	}
	if *jsonOutput {
		if err := json.NewEncoder(out).Encode(result); err != nil {
			return 1, fmt.Errorf("%s verify outside: write JSON result: %w", root.Name(), err)
		}
	} else {
		for _, module := range result.Modules {
			if _, err := fmt.Fprintf(out, "%s: %d failed tests (exit=%d); details: %s\n", module.Module, module.Failures, module.ExitCode, module.Log); err != nil {
				return 1, fmt.Errorf("%s verify outside: write result: %w", root.Name(), err)
			}
		}
	}
	return 0, nil
}

func verifyOutsideModule(moduleDir, packagePattern, logPath string, results *[]verifyOutsideModuleResult) (resultErr error) {
	if _, err := os.Stat(moduleDir); err != nil {
		return fmt.Errorf("module directory %s: %w", moduleDir, err)
	}
	goEnv := exec.Command("go", "env", "GOCACHE", "GOMODCACHE")
	goEnv.Dir = moduleDir
	goEnv.Env = os.Environ()
	cacheOutput, err := goEnv.Output()
	if err != nil {
		return fmt.Errorf("read Go cache paths: %w", err)
	}
	caches := strings.Split(strings.TrimSpace(string(cacheOutput)), "\n")
	if len(caches) != 2 {
		return fmt.Errorf("go env returned %d cache paths, want 2", len(caches))
	}
	home, err := os.MkdirTemp(os.Getenv("HOME"), "kb-runner-outside-")
	if err != nil {
		return fmt.Errorf("create temporary HOME: %w", err)
	}
	defer func() {
		if err := os.Chmod(home, 0o700); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("make temporary HOME removable: %w", err))
		}
		if err := os.RemoveAll(home); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove temporary HOME: %w", err))
		}
	}()
	env := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "KB_PLATFORM_ROOT" || key == "KB_HOME" || key == "KB_NET_OFFSET" || key == "GOFLAGS" || key == "HOME" {
			continue
		}
		env = append(env, entry)
	}
	env = append(env, "HOME="+home, "GOCACHE="+caches[0], "GOMODCACHE="+caches[1])
	list := exec.Command("go", "list", "-json", packagePattern)
	list.Dir = moduleDir
	list.Env = env
	listed, err := list.Output()
	if err != nil {
		return fmt.Errorf("list packages matching %s: %w", packagePattern, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(listed))
	packages := []string{}
	for {
		var item goPackage
		if err := decoder.Decode(&item); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return fmt.Errorf("decode go list package: %w", err)
		}
		if item.ImportPath == "" || item.Dir == "" {
			return errors.New("go list returned a package without import path or directory")
		}
		if excludedGoSuiteDir(item.Dir) {
			continue
		}
		packages = append(packages, item.ImportPath)
	}
	if len(packages) == 0 {
		return fmt.Errorf("no test packages remain after excluding e2e and journey under %s", packagePattern)
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create module JSONL %s: %w", logPath, err)
	}
	args := append([]string{"test", "-count=1", "-json"}, packages...)
	test := exec.Command("go", args...)
	test.Dir = moduleDir
	test.Env = env
	test.Stdout = log
	test.Stderr = log
	runErr := test.Run()
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return errors.Join(fmt.Errorf("start go test: %w", runErr), closeOutsideLog(log))
		}
		exitCode = exitErr.ExitCode()
	}
	if _, err := fmt.Fprintf(log, "exit=%d\n", exitCode); err != nil {
		return errors.Join(fmt.Errorf("append module exit status: %w", err), closeOutsideLog(log))
	}
	if err := log.Close(); err != nil {
		return fmt.Errorf("close module JSONL: %w", err)
	}
	failed, err := readOutsideFailures(logPath)
	if err != nil {
		return err
	}
	*results = append(*results, verifyOutsideModuleResult{Module: filepath.Base(moduleDir), Log: logPath, ExitCode: exitCode, Failures: len(failed), FailedTests: failed})
	return nil
}

func excludedGoSuiteDir(dir string) bool {
	for current := filepath.Clean(dir); current != filepath.Dir(current); current = filepath.Dir(current) {
		base := filepath.Base(current)
		if base == "e2e" || base == "journey" {
			return true
		}
	}
	return false
}

func readOutsideFailures(path string) (failed []verifyOutsideFailedTest, resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read module JSONL: %w", err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close module JSONL: %w", err))
		}
	}()
	failed = nil
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var event struct {
			Action  string
			Package string
			Test    string
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			if strings.HasPrefix(scanner.Text(), "exit=") {
				continue
			}
			return nil, fmt.Errorf("decode Go test JSON event in %s: %w", path, err)
		}
		if event.Action == "fail" && event.Test != "" {
			failed = append(failed, verifyOutsideFailedTest{Package: event.Package, Test: event.Test})
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan Go test JSONL: %w", err)
	}
	return failed, nil
}

func closeOutsideLog(log *os.File) error {
	if err := log.Close(); err != nil {
		return fmt.Errorf("close module JSONL: %w", err)
	}
	return nil
}
