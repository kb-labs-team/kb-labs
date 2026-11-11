//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func TestResolveTestChannelToolchainUsesRunnerModuleCache(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	goPath := filepath.Join(root, "gopath")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	moduleCache := filepath.Join(home, "operator-module-cache")
	makeModuleCache(t, moduleCache)
	goEnvFile := filepath.Join(root, "go.env")
	if err := os.WriteFile(goEnvFile, []byte("GOMODCACHE="+filepath.Join(root, "goenv-cache")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", goPath)
	t.Setenv("GOMODCACHE", moduleCache)
	t.Setenv("GOENV", goEnvFile)

	toolchain, err := resolveTestChannelToolchain()
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(moduleCache)
	if err != nil {
		t.Fatal(err)
	}
	if toolchain.GOMODCACHE != want {
		t.Fatalf("resolved module cache = %q, want runner cache %q", toolchain.GOMODCACHE, want)
	}
}

func TestResolveTestChannelToolchainUsesRunnerGoPathDefault(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	goPath := filepath.Join(root, "runner-gopath")
	moduleCache := filepath.Join(goPath, "pkg", "mod")
	makeModuleCache(t, moduleCache)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", goPath)
	t.Setenv("GOMODCACHE", "")

	toolchain, err := resolveTestChannelToolchain()
	if err != nil {
		t.Fatal(err)
	}
	canonicalModuleCache, err := canonicalSandboxPath(moduleCache)
	if err != nil {
		t.Fatal(err)
	}
	if toolchain.GOMODCACHE != canonicalModuleCache {
		t.Fatalf("resolved module cache = %q, want canonical GOPATH default %q", toolchain.GOMODCACHE, canonicalModuleCache)
	}
}

func TestResolveTestChannelToolchainRejectsInvalidModuleCacheLayout(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	config := filepath.Join(home, ".config")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", filepath.Join(root, "gopath"))
	t.Setenv("GOMODCACHE", config)

	_, err := resolveTestChannelToolchain()
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(refusal.Error(), config) || !strings.Contains(refusal.Error(), "cache/download") {
		t.Fatalf("invalid module cache result = %v, want typed refusal naming path and cache/download requirement", err)
	}
}

func TestResolveTestChannelToolchainRejectsSecretOverlappingModuleCache(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	secretCache := filepath.Join(home, ".codex", "module-cache")
	makeModuleCache(t, secretCache)
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", filepath.Join(root, "gopath"))
	t.Setenv("GOMODCACHE", secretCache)

	_, err := resolveTestChannelToolchain()
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(refusal.Error(), secretCache) {
		t.Fatalf("secret module cache result = %v, want typed refusal", err)
	}
}

func TestResolveTestChannelToolchainRejectsModuleCacheContainingSecretRoot(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	moduleCache := filepath.Join(home, "cache")
	makeModuleCache(t, moduleCache)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", filepath.Join(root, "gopath"))
	t.Setenv("GOMODCACHE", home)

	_, err := resolveTestChannelToolchain()
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(refusal.Error(), home) {
		t.Fatalf("module cache containing secret root result = %v, want typed refusal", err)
	}
}

func TestResolveTestChannelToolchainRejectsSymlinkedSecretModuleCache(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runner-home")
	secretCache := filepath.Join(home, ".codex", "module-cache")
	makeModuleCache(t, secretCache)
	alias := filepath.Join(root, "module-cache-alias")
	if err := os.Symlink(secretCache, alias); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GOPATH", filepath.Join(root, "gopath"))
	t.Setenv("GOMODCACHE", alias)

	_, err := resolveTestChannelToolchain()
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(refusal.Error(), secretCache) {
		t.Fatalf("symlinked secret module cache result = %v, want typed refusal", err)
	}
}

func makeModuleCache(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(path, "cache", "download"), 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestTestChannelSandboxProfileRefusesModuleCacheSecretOverlap(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, moduleCache := range []string{filepath.Join(home, ".codex", "cache"), filepath.Join(home, ".zcode-agent", "cache"), home} {
		_, err := testChannelSandboxProfile(worktree, filepath.Join(root, "temp-home"), "/usr/bin/true", runtime.GOROOT(), moduleCache, filepath.Join(root, "cache"), home, testChannelSandboxOptions{})
		var refusal testChannelRefusal
		if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" {
			t.Fatalf("module cache %q overlap result = %v, want typed KB_RUNTIME_INPUT_INVALID refusal", moduleCache, err)
		}
	}
}

func TestTestChannelSandboxProfileProbeOptionsChangeGeneratedRules(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	tempHome := filepath.Join(root, "temp-home")
	userHome := filepath.Join(root, "user-home")
	moduleCache := filepath.Join(root, "module-cache")
	goCache := filepath.Join(root, "go-cache")
	writeTarget := filepath.Join(root, "outside-target")
	for _, path := range []string{worktree, tempHome, userHome, moduleCache, goCache} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	strict, err := testChannelSandboxProfile(worktree, tempHome, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, userHome, testChannelSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	weak, err := testChannelSandboxProfile(worktree, tempHome, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, userHome, testChannelSandboxOptions{allowProbeSecretReads: true, allowProbeUnixSocket: true, allowProbeMachLookup: true, probeSymlinkWriteTarget: writeTarget})
	if err != nil {
		t.Fatal(err)
	}
	secretRoot, err := canonicalSandboxPath(filepath.Join(tempHome, ".codex"))
	if err != nil {
		t.Fatal(err)
	}
	canonicalTarget, err := canonicalSandboxPath(writeTarget)
	if err != nil {
		t.Fatal(err)
	}
	for _, rule := range []string{
		`(deny file-read* (subpath ` + strconv.Quote(secretRoot) + `)`,
		`(deny network*)`,
	} {
		if !strings.Contains(strict, rule) {
			t.Fatalf("strict profile lacks %q: %s", rule, strict)
		}
	}
	for _, rule := range []string{
		`(allow network-outbound)`,
		`(allow mach-lookup)`,
		`(allow file-write* (subpath ` + strconv.Quote(canonicalTarget) + `))`,
	} {
		if strings.Contains(strict, rule) {
			t.Fatalf("strict profile unexpectedly contains %q: %s", rule, strict)
		}
	}
	for _, rule := range []string{
		`(allow network-outbound)`,
		`(allow mach-lookup)`,
		`(allow file-write* (subpath ` + strconv.Quote(canonicalTarget) + `))`,
	} {
		if !strings.Contains(weak, rule) {
			t.Fatalf("weakened profile lacks %q: %s", rule, weak)
		}
	}
	if strings.Contains(weak, `(deny file-read* (subpath `+strconv.Quote(secretRoot)+`)`) {
		t.Fatalf("weakened profile retained secret denial: %s", weak)
	}
	if strings.Contains(weak, `/\.zcode[^/]*`) || strings.Contains(weak, `/\.env(\.[^/]*)?`) {
		t.Fatalf("weakened profile retained a secret pattern denial: %s", weak)
	}
}

func TestTestChannelProfileDeniesDataVolumeSecretAliases(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	tempHome := filepath.Join(root, "temp-home")
	userHome := filepath.Join(root, "user-home")
	moduleCache := filepath.Join(root, "module-cache")
	goCache := filepath.Join(root, "go-cache")
	for _, path := range []string{worktree, tempHome, userHome, moduleCache, goCache} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	profile, err := testChannelSandboxProfile(worktree, tempHome, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, userHome, testChannelSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	canonicalHome, err := canonicalSandboxPath(userHome)
	if err != nil {
		t.Fatal(err)
	}
	dataVolumeHome := darwinDataVolumeAlias(canonicalHome)
	for _, alias := range []string{filepath.Join(dataVolumeHome, ".ssh"), filepath.Join(dataVolumeHome, ".codex"), filepath.Join(dataVolumeHome, ".claude"), filepath.Join(dataVolumeHome, "Library", "Keychains")} {
		if !strings.Contains(profile, `(deny file-read* (subpath `+strconv.Quote(alias)+`)`) {
			t.Fatalf("generated profile lacks Data-volume secret denial for %q", alias)
		}
	}
	zcodeAliasPattern := "^" + regexp.QuoteMeta(dataVolumeHome) + "/" + regexp.QuoteMeta(".zcode") + `[^/]*(/.*)?$`
	if !strings.Contains(profile, zcodeAliasPattern) {
		t.Fatalf("generated profile lacks Data-volume .zcode pattern denial %q", zcodeAliasPattern)
	}
	weakened, err := testChannelSandboxProfile(worktree, tempHome, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, userHome, testChannelSandboxOptions{allowProbeSecretReads: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(weakened, `(deny file-read* (subpath `+strconv.Quote(filepath.Join(dataVolumeHome, ".ssh"))+`)`) {
		t.Fatal("weakened profile retained Data-volume secret denial")
	}
	if strings.Contains(weakened, zcodeAliasPattern) {
		t.Fatal("weakened profile retained Data-volume .zcode pattern denial")
	}
}

func TestTestChannelExecutorDoesNotReadAmbientModuleCacheSecret(t *testing.T) {
	setTestRunnerHome(t)
	root := t.TempDir()
	module := filepath.Join(root, "module")
	secretCache := filepath.Join(root, "planted-secret-cache")
	if err := os.MkdirAll(module, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secretCache, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(secretCache, "credential")
	if err := os.WriteFile(secret, []byte("ambient-cache-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(module, "go.mod"), []byte("module example.test/ambient-cache\n\ngo 1.23\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := "package ambient\nimport (\"os\"; \"testing\")\nfunc TestAmbientModuleCacheSecret(t *testing.T) { if _, err := os.ReadFile(" + strconv.Quote(secret) + "); err == nil { t.Fatal(\"ambient module cache secret was readable\") } }\n"
	if err := os.WriteFile(filepath.Join(module, "ambient_test.go"), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOMODCACHE", secretCache)
	t.Setenv("GOPATH", secretCache)
	result := newTestChannelExecutor().Execute(context.Background(), testExecution{Request: TestRequest{Module: module, Packages: []string{"."}, Run: "^TestAmbientModuleCacheSecret$", Count: 1, Timeout: time.Minute}, JobID: "job-ambient-cache", RequestID: "request-ambient-cache", State: filepath.Join(root, "state"), Stream: "stream-ambient-cache"})
	if result.DiagnosticCode == "KB_RUNTIME_INPUT_INVALID" {
		return
	}
	if result.Passed != 1 || result.Failed != 0 || strings.Contains(strings.Join(result.LogTail, "\n"), "ambient module cache secret was readable") {
		t.Fatalf("real executor did not deny the ambient module-cache secret: %+v", result)
	}
}

func TestTestChannelSandboxAllowsProcessTableAndDeniesSecretAndNetwork(t *testing.T) {
	setTestRunnerHome(t)
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	worktree := filepath.Join(home, "worktree")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	secretFiles := []struct {
		path         string
		probeAliases bool
	}{
		{path: filepath.Join(home, ".codex", "planted-secret"), probeAliases: true},
		{path: filepath.Join(home, ".claude", "planted-secret"), probeAliases: true},
		{path: filepath.Join(home, ".zcode-agent", "planted-secret")},
		{path: filepath.Join(home, ".kb", "credentials.json")},
		{path: filepath.Join(home, ".ssh", "id_ed25519"), probeAliases: true},
		{path: filepath.Join(home, ".env")},
		{path: filepath.Join(home, "Library", "Keychains", "fake-keychain"), probeAliases: true},
	}
	secretPaths := make([]string, 0, len(secretFiles)+2)
	for _, secret := range secretFiles {
		secretPaths = append(secretPaths, secret.path)
	}
	moduleCache := filepath.Join(home, "module-cache")
	if err := os.MkdirAll(moduleCache, 0o700); err != nil {
		t.Fatal(err)
	}
	secretPaths = append(secretPaths, filepath.Join(moduleCache, "dependency", ".env"))
	secretPaths = append(secretPaths, filepath.Join(moduleCache, "dependency", ".env.local"))
	for _, path := range secretPaths {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x212-secret"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	hardlinkPath := filepath.Join(worktree, "linked-secret")
	if err := os.Link(secretPaths[0], hardlinkPath); err != nil {
		t.Fatal(err)
	}
	writeTarget := filepath.Join(root, "outside-write-target")
	if err := os.WriteFile(writeTarget, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	writePath := filepath.Join(worktree, "outside-write-link")
	if err := os.Symlink(writeTarget, writePath); err != nil {
		t.Fatal(err)
	}
	goCache := filepath.Join(home, "gocache")
	if err := os.MkdirAll(goCache, 0o700); err != nil {
		t.Fatal(err)
	}
	type aliasGroup struct {
		name  string
		flag  string
		paths []string
	}
	aliasGroups := []aliasGroup{
		{name: "DATA_VOLUME", flag: "data-volume-aliases"},
		{name: "WORKTREE", flag: "worktree-aliases"},
		{name: "TEMP_HOME", flag: "temp-home-aliases"},
		{name: "GOCACHE", flag: "gocache-aliases"},
	}
	for secretIndex, secret := range secretFiles {
		if !secret.probeAliases {
			continue
		}
		canonicalSecret, err := canonicalSandboxPath(secret.path)
		if err != nil {
			t.Fatalf("canonicalize planted alias secret %q: %v", secret.path, err)
		}
		dataAlias := darwinDataVolumeAlias(canonicalSecret)
		canonicalInfo, err := os.Stat(canonicalSecret)
		if err != nil {
			t.Fatalf("stat canonical planted secret %q: %v", canonicalSecret, err)
		}
		dataInfo, err := os.Stat(dataAlias)
		if err != nil || !os.SameFile(canonicalInfo, dataInfo) {
			t.Fatalf("Data-volume path %q does not alias planted secret %q: stat err=%v", dataAlias, canonicalSecret, err)
		}
		aliasGroups[0].paths = append(aliasGroups[0].paths, dataAlias)
		for rootIndex, allowedRoot := range []string{worktree, home, goCache} {
			aliasDir := filepath.Join(allowedRoot, "test-channel-secret-aliases")
			if err := os.MkdirAll(aliasDir, 0o700); err != nil {
				t.Fatalf("create alias directory under allowed root %q: %v", allowedRoot, err)
			}
			aliasPath := filepath.Join(aliasDir, strconv.Itoa(secretIndex)+"-target")
			if err := os.Symlink(canonicalSecret, aliasPath); err != nil {
				t.Fatalf("create secret symlink under allowed root %q: %v", allowedRoot, err)
			}
			aliasGroups[rootIndex+1].paths = append(aliasGroups[rootIndex+1].paths, aliasPath)
		}
	}
	toolchain, err := resolveTestChannelToolchain()
	if err != nil {
		t.Fatal(err)
	}
	profile, err := testChannelSandboxProfile(worktree, home, toolchain.GoBinary, toolchain.GOROOT, moduleCache, goCache, home, testChannelSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probePath := filepath.Join(home, "probe")
	moduleRoot, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	build := exec.Command(toolchain.GoBinary, "build", "-o", probePath, "./testdata/sandboxprobe/main.go")
	build.Dir = moduleRoot
	build.Env = []string{"HOME=" + home, "TMPDIR=" + home, "PATH=" + filepath.Dir(toolchain.GoBinary) + ":/usr/bin:/bin", "GOPROXY=off", "GOMODCACHE=" + toolchain.GOMODCACHE, "GOFLAGS=-mod=readonly", "GOENV=off", "GOTOOLCHAIN=local"}
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build standalone sandbox probe with %q in %q: %v\n%s", build.Args, build.Dir, err, output)
	}
	probePath, err = canonicalSandboxPath(probePath)
	if err != nil {
		t.Fatalf("canonicalize sandbox probe executable: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	unixDir, err := os.MkdirTemp("/private/tmp", "x212-unix-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(unixDir)
	unixPath := filepath.Join(unixDir, "probe.sock")
	unixListener, err := net.Listen("unix", unixPath)
	if err != nil {
		t.Fatal(err)
	}
	defer unixListener.Close()
	probeArgs := []string{"-secrets", strings.Join(secretPaths, string(os.PathListSeparator)), "-target", listener.Addr().String(), "-unix-target", unixPath, "-hardlink", hardlinkPath, "-write-path", writePath}
	for _, group := range aliasGroups {
		if len(group.paths) == 0 {
			t.Fatalf("no alias probe paths were generated for %s", group.name)
		}
		probeArgs = append(probeArgs, "-"+group.flag, strings.Join(group.paths, string(os.PathListSeparator)))
	}
	runProbe := func(name, profile string) []byte {
		t.Helper()
		profilePath := filepath.Join(home, name+".sb")
		if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
			t.Fatal(err)
		}
		command := exec.Command(testChannelSandboxExec, append([]string{"-f", profilePath, probePath}, probeArgs...)...)
		command.Dir = worktree
		command.Env = []string{"HOME=" + home, "TMPDIR=" + home, "PATH=" + filepath.Dir(toolchain.GoBinary), "GOTOOLCHAIN=local"}
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("%s sandbox probe failed: %v\n%s", name, err, output)
		}
		return output
	}
	weakenedProfile, err := testChannelSandboxProfile(worktree, home, toolchain.GoBinary, toolchain.GOROOT, moduleCache, goCache, home, testChannelSandboxOptions{allowProbeSecretReads: true, allowProbeUnixSocket: true, allowProbeMachLookup: true, probeSymlinkWriteTarget: writeTarget})
	if err != nil {
		t.Fatal(err)
	}
	weakenedOutput := runProbe("weakened", weakenedProfile)
	allowedMarkers := []string{"UNIX_SOCKET_ALLOWED", "MACH_LOOKUP_ALLOWED", "SYMLINK_WRITE_ALLOWED"}
	for _, secret := range secretPaths {
		allowedMarkers = append(allowedMarkers, "SECRET_ALLOWED "+secret)
	}
	for _, want := range allowedMarkers {
		if !strings.Contains(string(weakenedOutput), want) {
			t.Fatalf("weakened profile probe output %q lacks %s", weakenedOutput, want)
		}
	}
	for _, group := range aliasGroups {
		for _, aliasPath := range group.paths {
			want := group.name + "_ALIAS_READ_ALLOWED " + aliasPath
			if !strings.Contains(string(weakenedOutput), want) {
				t.Fatalf("weakened profile probe output %q lacks %s", weakenedOutput, want)
			}
		}
	}
	if err := os.WriteFile(writeTarget, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := runProbe("enforced", profile)
	for _, want := range []string{"PROCESS_TABLE_ALLOWED", "PROCESS_ARGS_ALLOWED", "NETWORK_DENIED", "UNIX_SOCKET_DENIED", "MACH_LOOKUP_DENIED", "SYMLINK_WRITE_DENIED"} {
		if !strings.Contains(string(output), want) {
			t.Fatalf("sandbox probe output %q lacks %s", output, want)
		}
	}
	for _, path := range secretPaths {
		want := "SECRET_DENIED " + path
		if !strings.Contains(string(output), want) {
			t.Fatalf("sandbox probe output %q lacks %s", output, want)
		}
	}
	for _, group := range aliasGroups {
		for _, aliasPath := range group.paths {
			want := group.name + "_ALIAS_READ_DENIED " + aliasPath
			if !strings.Contains(string(output), want) {
				t.Fatalf("sandbox probe output %q lacks %s", output, want)
			}
		}
	}
	if strings.Contains(string(output), "SECRET_ALLOWED") || strings.Contains(string(output), "ALIAS_READ_ALLOWED") || strings.Contains(string(output), "NETWORK_ALLOWED") || strings.Contains(string(output), "PROCESS_DENIED") || strings.Contains(string(output), "PROCESS_ARGS_DENIED") {
		t.Fatalf("sandbox allowed a forbidden probe: %s", output)
	}
	if !strings.Contains(string(output), "HARDLINK_READ_ALLOWED") {
		t.Fatalf("macOS path policy should be measured as unable to deny a hard-link alias; output: %s", output)
	}
	t.Log("profile cannot deny a hard-link alias; executor preflight does")
	preflightResult := newTestChannelExecutor().Execute(context.Background(), testExecution{Request: TestRequest{Module: worktree}})
	if preflightResult.DiagnosticCode != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("real test-channel executor did not refuse the hard-link module: %+v", preflightResult)
	}
	if data, err := os.ReadFile(writeTarget); err != nil || string(data) != "unchanged" {
		t.Fatalf("worktree symlink write changed outside target: data=%q err=%v", data, err)
	}
}

func TestTestChannelExecutorRefusesHardLinkBeforeSandboxStart(t *testing.T) {
	root := t.TempDir()
	module := filepath.Join(root, "module")
	if err := os.MkdirAll(module, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(module, "go.mod"), []byte("module example.test/hardlink\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(root, "secret")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, filepath.Join(module, "linked-secret")); err != nil {
		t.Fatal(err)
	}
	result := newTestChannelExecutor().Execute(context.Background(), testExecution{Request: TestRequest{Module: module}})
	if result.DiagnosticCode != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("hard-link result = %+v, want typed refusal before sandbox", result)
	}
}

func TestTestChannelExecutorStopsNoisyOutputAtHardCeiling(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "module")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/noisy\n\ngo 1.23\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	source := "package noisy\nimport (\"fmt\"; \"strings\"; \"testing\")\nfunc TestNoisy(t *testing.T) { chunk := strings.Repeat(\"x\", 65536); for { _, _ = fmt.Print(chunk) } }\n"
	if err := os.WriteFile(filepath.Join(worktree, "noisy_test.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	result := executeTestRequest(context.Background(), testExecution{Request: TestRequest{Module: worktree, Packages: []string{"."}, Run: "^TestNoisy$", Count: 1, Timeout: time.Minute}, JobID: "job-output-limit", State: filepath.Join(root, "state"), Stream: "stream-output-limit"})
	if result.Passed+result.Failed == 0 && result.Outcome != testOutcomeOutputLimitExceeded {
		t.Fatalf("noisy fixture did not run: %+v", result)
	}
	if result.Outcome != testOutcomeOutputLimitExceeded {
		t.Fatalf("output result = %+v, want typed output limit", result)
	}
	if result.OutputBytes <= testChannelOutputLimit || result.DroppedBytes == 0 || result.logBytes() > testChannelMaxLogBytes {
		t.Fatalf("output bounds not reflected: %+v", result)
	}
}

func TestTestChannelExecutorWritesPassAndFailResults(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/channel-fixture\n\ngo 1.23\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := "package fixture\nimport \"testing\"\nfunc TestPass(t *testing.T) {}\nfunc TestFail(t *testing.T) { t.Fatal(\"fixture failure\") }\n"
	if err := os.WriteFile(filepath.Join(worktree, "fixture_test.go"), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	state, jobID, stream := filepath.Join(root, "state"), "job-test-channel-e2e", "stream-test-channel-e2e"
	spool := testChannelSpool(state, jobID)
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	broker := testChannelBroker{state: state, jobID: jobID, stream: stream, worktree: worktree, spool: spool, executor: newTestChannelExecutor()}
	for _, test := range []struct {
		name                         string
		wantExit, wantPass, wantFail int
		failing                      string
	}{
		{name: "pass", wantExit: 0, wantPass: 1},
		{name: "fail", wantExit: 1, wantFail: 1, failing: "TestFail"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := testRequest{ID: "request-" + test.name, Workdir: worktree, Args: []string{"go", "-run", "^Test" + strings.Title(test.name) + "$", "."}}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := broker.handle(ctx, request); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(spool, "result-"+request.ID+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var result testResult
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
			if result.ExitCode != test.wantExit || result.Passed != test.wantPass || result.Failed != test.wantFail {
				t.Fatalf("result = %+v, want exit/pass/fail %d/%d/%d", result, test.wantExit, test.wantPass, test.wantFail)
			}
			if test.failing != "" && !testChannelHasName(result.Failing, test.failing) {
				t.Fatalf("failing tests = %v, want %s", result.Failing, test.failing)
			}
		})
	}
	if info, err := os.Stat(testChannelCachePath(state, stream)); err != nil || !info.IsDir() {
		t.Fatalf("stream Go cache missing: info=%v err=%v", info, err)
	}
}

func TestTestChannelExecutorReportsAdmissionReason(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/channel-admission\n\ngo 1.23\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, jobID := filepath.Join(root, "state"), "job-test-channel-admission"
	spool := testChannelSpool(state, jobID)
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	broker := testChannelBroker{state: state, jobID: jobID, stream: "stream-test-channel-admission", worktree: worktree, spool: spool, executor: newTestChannelExecutor()}
	request := testRequest{ID: "admission-request", Workdir: worktree, Args: []string{"go", "-timeout", "350ms", "."}}
	started := time.Now()
	if err := broker.handle(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("admission refusal took too long: %s", time.Since(started))
	}
	data, err := os.ReadFile(filepath.Join(spool, "result-"+request.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var result testResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.AdmissionReason == "" {
		t.Fatalf("admission result omitted queued reason: %+v", result)
	}
	if !strings.Contains(result.Diagnostic, "context deadline exceeded") {
		t.Fatalf("admission diagnostic omitted cancellation cause: %+v", result)
	}
}

type testChannelTestResourceSource struct{}

func (testChannelTestResourceSource) Snapshot() proc.HostResourceSnapshot {
	return proc.HostResourceSnapshot{
		PhysicalMemory: 16 << 30, AvailableMemory: 12 << 30, MemoryAvailableKnown: true,
		PressureAvailable: true, LoadAvailable: true, LogicalCPUs: 8, Pressure: "normal", Load1: 0,
	}
}

type testChannelWarnResourceSource struct{}

func (testChannelWarnResourceSource) Snapshot() proc.HostResourceSnapshot {
	return proc.HostResourceSnapshot{PressureAvailable: true, Pressure: "memory warn", LogicalCPUs: 8}
}

func testChannelHasName(names []string, expected string) bool {
	for _, name := range names {
		if name == expected {
			return true
		}
	}
	return false
}

func TestTestChannelSandboxProfileUsesCanonicalNarrowReadRoots(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(worktree, alias); err != nil {
		t.Fatal(err)
	}
	moduleCache := filepath.Join(root, "module-cache")
	goCache := filepath.Join(root, "go-cache")
	if err := os.MkdirAll(moduleCache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(goCache, 0o700); err != nil {
		t.Fatal(err)
	}
	profile, err := testChannelSandboxProfile(alias, root, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, root, testChannelSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	canonicalWorktree, err := canonicalSandboxPath(worktree)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`(literal "/")`,
		`(literal "/dev/null")`,
		`(allow file-read-metadata)`,
		`(allow file-read* (subpath "/usr/lib"))`,
		`(allow file-read* (subpath "/System"))`,
		`(allow file-read* (subpath ` + strconv.Quote(canonicalWorktree) + `))`,
	} {
		if !strings.Contains(profile, want) {
			t.Fatalf("sandbox profile lacks %s: %s", want, profile)
		}
	}
	for _, forbidden := range []string{`(subpath "/usr")`, `(subpath "/bin")`, `(subpath "/sbin")`, `(subpath "/dev")`} {
		if strings.Contains(profile, forbidden) {
			t.Fatalf("sandbox profile has broad read root %s: %s", forbidden, profile)
		}
	}
}

// case: S-237.143
func TestTestChannelProfileSecretRegexUsesCanonicalHomeAndDeniesEnvVariants(t *testing.T) {
	root := t.TempDir()
	realHome := filepath.Join(root, "real-home")
	if err := os.MkdirAll(realHome, 0o700); err != nil {
		t.Fatal(err)
	}
	homeAlias := filepath.Join(root, "home-alias")
	if err := os.Symlink(realHome, homeAlias); err != nil {
		t.Fatal(err)
	}
	worktree := t.TempDir()
	tempHome := t.TempDir()
	moduleCache := t.TempDir()
	goCache := t.TempDir()
	profile, err := testChannelSandboxProfile(worktree, tempHome, "/usr/bin/true", runtime.GOROOT(), moduleCache, goCache, homeAlias, testChannelSandboxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	canonicalHome, err := filepath.EvalSymlinks(homeAlias)
	if err != nil {
		t.Fatal(err)
	}
	canonicalModuleCache, err := filepath.EvalSymlinks(moduleCache)
	if err != nil {
		t.Fatal(err)
	}
	wantZcodeRule := `(deny file-read* (regex #"` + "^" + regexp.QuoteMeta(canonicalHome) + `/\.zcode[^/]*(/.*)?$"))`
	wantEnvRule := `(deny file-read* (regex #"` + "^" + regexp.QuoteMeta(canonicalModuleCache) + `(/.*)?/\.env(\.[^/]*)?$"))`
	for _, want := range []string{wantZcodeRule, wantEnvRule} {
		if !strings.Contains(profile, want) {
			t.Fatalf("sandbox profile lacks canonical secret rule %q:\n%s", want, profile)
		}
	}
}

func TestTestChannelProfileRefusesUncanonicalizablePath(t *testing.T) {
	root := t.TempDir()
	dangling := filepath.Join(root, "dangling")
	if err := os.Symlink(filepath.Join(root, "missing"), dangling); err != nil {
		t.Fatal(err)
	}
	_, err := testChannelSandboxProfile(dangling, root, "/usr/bin/true", runtime.GOROOT(), root, root, root, testChannelSandboxOptions{})
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("uncanonicalizable path error = %v, want typed KB_RUNTIME_INPUT_INVALID refusal", err)
	}
	result := testChannelErrorResult("", err)
	if result.DiagnosticCode != refusal.Code || !strings.Contains(result.Diagnostic, "next:") {
		t.Fatalf("canonicalization refusal result = %+v, want catalogued code and derived next hint", result)
	}
	secretRoot := t.TempDir()
	secretWorktree := filepath.Join(secretRoot, "worktree")
	if err := os.MkdirAll(secretWorktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(secretRoot, "missing-secret-root"), filepath.Join(secretRoot, ".codex")); err != nil {
		t.Fatal(err)
	}
	_, err = testChannelSandboxProfile(secretWorktree, secretRoot, "/usr/bin/true", runtime.GOROOT(), secretRoot, secretRoot, secretRoot, testChannelSandboxOptions{})
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("unresolvable secret boundary error = %v, want typed KB_RUNTIME_INPUT_INVALID refusal", err)
	}
}
