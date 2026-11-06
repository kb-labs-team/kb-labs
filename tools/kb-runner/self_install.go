//go:build darwin || linux

package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func selfInstallCommand(root runnerRoot, args []string, stdout, stderr io.Writer) (code int, resultErr error) {
	fs := flag.NewFlagSet("self-install", flag.ContinueOnError)
	fs.SetOutput(stderr)
	source := fs.String("source", "", "kb-runner Go module directory")
	destination := fs.String("root", "", "directory that will contain bin/kb-runner and bin/kb-runner-zcode")
	if err := fs.Parse(args); err != nil {
		return 2, fmt.Errorf("%s self-install: %w; next: %s self-install --help", root.Name(), err, root.InvocationCommand())
	}
	if fs.NArg() != 0 || *source == "" || *destination == "" {
		return 2, fmt.Errorf("%s self-install: --source and --root are required; next: %s self-install --help", root.Name(), root.InvocationCommand())
	}
	module, err := filepath.Abs(*source)
	if err != nil {
		return 1, fmt.Errorf("%s self-install: resolve source: %w; next: %s self-install --help", root.Name(), err, root.InvocationCommand())
	}
	moduleInfo, err := os.Stat(filepath.Join(module, "go.mod"))
	if err != nil || !moduleInfo.Mode().IsRegular() {
		return 1, fmt.Errorf("%s self-install: source %q must contain a regular go.mod; next: %s self-install --help", root.Name(), module, root.InvocationCommand())
	}
	binDir := filepath.Join(*destination, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return 1, fmt.Errorf("%s self-install: create %s: %w; next: %s self-install --help", root.Name(), binDir, err, root.InvocationCommand())
	}
	installed := []string{"kb-runner", "kb-runner-zcode"}
	candidates := make([]string, 0, len(installed))
	defer func() {
		for _, path := range candidates {
			if path == "" {
				continue
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove temporary install candidate %s: %w", path, err))
				code = 1
			}
		}
	}()
	for _, name := range installed {
		file, err := os.CreateTemp(binDir, "."+name+"-install-*")
		if err != nil {
			return 1, fmt.Errorf("%s self-install: prepare %s: %w; next: %s self-install --help", root.Name(), name, err, root.InvocationCommand())
		}
		candidate := file.Name()
		if err := file.Close(); err != nil {
			candidates = append(candidates, candidate)
			return 1, fmt.Errorf("%s self-install: close build target for %s: %w; next: %s self-install --help", root.Name(), name, err, root.InvocationCommand())
		}
		candidates = append(candidates, candidate)
		build := exec.Command("go", "build", "-o", candidate, ".")
		build.Dir = module
		output, err := build.CombinedOutput()
		if err != nil {
			return 1, fmt.Errorf("%s self-install: build %s: %s: %w; next: %s self-install --help", root.Name(), name, strings.TrimSpace(string(output)), err, root.InvocationCommand())
		}
		if err := os.Chmod(candidate, 0o755); err != nil {
			return 1, fmt.Errorf("%s self-install: set executable mode for %s: %w; next: %s self-install --help", root.Name(), name, err, root.InvocationCommand())
		}
		check := exec.Command(candidate, "--version")
		var version bytes.Buffer
		check.Stdout = &version
		check.Stderr = &version
		if err := check.Run(); err != nil || strings.TrimSpace(version.String()) != runnerVersion {
			return 1, fmt.Errorf("%s self-install: candidate %s failed the --version contract (want %q, got %q); next: %s self-install --help", root.Name(), name, runnerVersion, strings.TrimSpace(version.String()), root.InvocationCommand())
		}
	}
	for index, name := range installed {
		if err := os.Rename(candidates[index], filepath.Join(binDir, name)); err != nil {
			return 1, fmt.Errorf("%s self-install: atomically replace %s: %w; next: %s self-install --help", root.Name(), name, err, root.InvocationCommand())
		}
		candidates[index] = ""
	}
	if _, err := fmt.Fprintf(stdout, "Installed %s and %s in %s\n", installed[0], installed[1], binDir); err != nil {
		return 1, fmt.Errorf("%s self-install: write result: %w", root.Name(), err)
	}
	return 0, nil
}
