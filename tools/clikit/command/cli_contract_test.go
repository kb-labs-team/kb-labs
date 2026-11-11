package command

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// case: S-203.6
func TestEveryClikitToolBinaryHelpAndUnknownCommand(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate clikit command test source")
	}
	toolsRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	workspaceRoot := filepath.Dir(toolsRoot)

	moduleRoots, err := toolModuleRoots(toolsRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(moduleRoots) == 0 {
		t.Fatal("tools tree contains no Go module roots")
	}

	var packages []listedPackage
	for _, module := range moduleRoots {
		listed, err := listModulePackages(filepath.Join(workspaceRoot, module))
		if err != nil {
			t.Fatalf("list package graph in Go module %s: %v", module, err)
		}
		packages = append(packages, listed...)
	}
	cliBinaries := rootClikitBinaries(discoveredMainPackages(packages), packages)
	if len(cliBinaries) == 0 {
		t.Fatal("tools tree contains no clikit CLI binaries")
	}
	seenNames := make(map[string]struct{}, len(cliBinaries))
	for _, mainPackage := range cliBinaries {
		name := filepath.Base(mainPackage.modulePath)
		if _, exists := seenNames[name]; exists {
			t.Fatalf("multiple discovered clikit binaries share the invocation name %q", name)
		}
		seenNames[name] = struct{}{}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			temporary := t.TempDir()
			home := filepath.Join(temporary, "home")
			if err := os.Mkdir(home, 0o700); err != nil {
				t.Fatal(err)
			}
			binaryPath := filepath.Join(temporary, name)
			build := exec.Command("go", "build", "-o", binaryPath, mainPackage.importPath)
			build.Dir = filepath.Join(workspaceRoot, mainPackage.modulePath)
			if output, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build clikit binary %s: %v\n%s", mainPackage.importPath, err, output)
			}
			for _, helpArgs := range [][]string{{"--help"}, {"-h"}, {"help"}} {
				output, err := runBinary(binaryPath, helpArgs, home)
				if err != nil {
					t.Fatalf("%s %s: %v\n%s", name, strings.Join(helpArgs, " "), err, output)
				}
				if !strings.Contains(output, "Usage:") && !strings.Contains(output, "Commands:") {
					t.Fatalf("%s %s did not print usage: %s", name, strings.Join(helpArgs, " "), output)
				}
			}
			output, err := runBinary(binaryPath, []string{"x70-command-that-does-not-exist"}, home)
			if err == nil {
				t.Fatalf("%s accepted an unknown command: %s", name, output)
			}
			if !strings.Contains(output, name+" --help") {
				t.Fatalf("%s unknown-command hint did not name its invocation help command: %s", name, output)
			}
		})
	}
}

type listedPackage struct {
	modulePath string
	moduleRoot string
	name       string
	importPath string
	imports    []string
}

type mainPackage struct {
	modulePath string
	importPath string
}

func toolModuleRoots(toolsRoot string) ([]string, error) {
	var modules []string
	err := filepath.WalkDir(toolsRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Name() != "go.mod" {
			return nil
		}
		relative, err := filepath.Rel(filepath.Dir(toolsRoot), filepath.Dir(path))
		if err != nil {
			return fmt.Errorf("locate Go module manifest %s: %w", path, err)
		}
		modules = append(modules, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("discover tools Go module manifests: %w", err)
	}
	sort.Strings(modules)
	return modules, nil
}

func listModulePackages(moduleDir string) ([]listedPackage, error) {
	const format = `{{.Module.Path}}|{{.Name}}|{{.ImportPath}}|{{join .Imports ","}}`
	command := exec.Command("go", "list", "-f", format, "./...")
	command.Dir = moduleDir
	output, err := command.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("go list ./...: %w\n%s", err, exit.Stderr)
		}
		return nil, fmt.Errorf("go list ./...: %w", err)
	}
	var packages []listedPackage
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "|", 4)
		if len(fields) != 4 {
			return nil, fmt.Errorf("go list returned an invalid package record %q", line)
		}
		packages = append(packages, listedPackage{
			modulePath: filepath.ToSlash(filepath.Base(moduleDir)),
			moduleRoot: fields[0],
			name:       fields[1],
			importPath: fields[2],
			imports:    strings.Split(fields[3], ","),
		})
	}
	if len(packages) == 0 {
		return nil, fmt.Errorf("go list ./... returned no packages")
	}
	return packages, nil
}

func discoveredMainPackages(packages []listedPackage) []mainPackage {
	var mains []mainPackage
	for _, pkg := range packages {
		if pkg.name == "main" {
			mains = append(mains, mainPackage{modulePath: "tools/" + pkg.modulePath, importPath: pkg.importPath})
		}
	}
	sort.Slice(mains, func(i, j int) bool { return mains[i].importPath < mains[j].importPath })
	return mains
}

func rootClikitBinaries(mains []mainPackage, packages []listedPackage) []mainPackage {
	byImportPath := make(map[string]listedPackage, len(packages))
	for _, pkg := range packages {
		byImportPath[pkg.importPath] = pkg
	}
	var binaries []mainPackage
	for _, main := range mains {
		pkg := byImportPath[main.importPath]
		if main.importPath == pkg.moduleRoot && containsString(pkg.imports, "github.com/kb-labs/clikit/command") {
			binaries = append(binaries, main)
		}
	}
	return binaries
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func runBinary(binaryPath string, args []string, home string) (string, error) {
	command := exec.Command(binaryPath, args...)
	command.Env = testEnvironment(home)
	output, err := command.CombinedOutput()
	return string(output), err
}

func testEnvironment(home string) []string {
	environment := make([]string, 0, len(os.Environ())+1)
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if name == "HOME" || name == "KB_PLATFORM_ROOT" || name == "KB_HOME" || name == "KB_NET_OFFSET" || name == "GOFLAGS" {
			continue
		}
		environment = append(environment, value)
	}
	return append(environment, "HOME="+home)
}
