//go:build !windows

package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/tempdirguard"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestStartStatusErrorRemainsAnError(t *testing.T) {
	statusErr := diag.New(contracts.CodeReceiptUnavailable, "status could not read the active receipt")
	got := startStatusDiagnostic(statusErr)
	if got.Code != statusErr.Code || got.Message != statusErr.Message {
		t.Fatalf("status diagnostic = %#v, want the status failure", got)
	}
}

// case: S-053.4, S-053.5, S-053.7, S-053.8
func TestBuiltCLICompatibilityRefusalsMatchCasesWithoutMutatingRoots(t *testing.T) {
	launcher, _ := binaries(t)
	_, sourceFile, _, ok := goruntime.Caller(0)
	if !ok {
		t.Fatal("could not locate command test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../.."))
	fixtureDir := filepath.Join(repoRoot, "e2e", "platform", "fixtures", "installer-cases")
	arch := goruntime.GOARCH
	if arch == "x86_64" {
		arch = "amd64"
	}
	if arch == "aarch64" {
		arch = "arm64"
	}
	fixtureOS := goruntime.GOOS
	if fixtureOS != "linux" && fixtureOS != "darwin" {
		t.Skip("compatibility command fixtures cover Linux and macOS")
	}
	matrix := filepath.Join(fixtureDir, "compatibility-matrix-"+fixtureOS+"-"+arch+".json")
	missingBinary := filepath.Join(fixtureDir, "missing-host-binary-"+fixtureOS+"-"+arch+".json")
	for _, path := range []string{matrix, missingBinary} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("required release fixture %q: %v", path, err)
		}
	}

	runPlanWithPlatform := func(t *testing.T, index, root string, platformSelection []string, extra ...string) map[string]any {
		t.Helper()
		home := t.TempDir()
		args := []string{"plan", "--json", "--index", index,
			"--policy", "compatible", "--platform-root", root}
		args = append(args[:4], append(platformSelection, args[4:]...)...)
		args = append(args, extra...)
		command := exec.Command(launcher, args...)
		command.Env = childEnvironment(os.Environ(), map[string]string{"HOME": home,
			"KB_PLATFORM_ROOT": "", "KB_HOME": "", "KB_NET_OFFSET": "", "XDG_DATA_HOME": ""})
		output, err := command.CombinedOutput()
		if err == nil {
			t.Fatalf("plan unexpectedly succeeded: %s", output)
		}
		var envelope struct {
			Error map[string]any `json:"error"`
		}
		if err := json.Unmarshal(output, &envelope); err != nil {
			t.Fatalf("plan output is not the structured JSON error: %s (%v)", output, err)
		}
		if envelope.Error["code"] != contracts.CodeIncompatibleComponents {
			t.Fatalf("plan error = %#v, want %s", envelope.Error, contracts.CodeIncompatibleComponents)
		}
		return envelope.Error
	}
	runPlan := func(t *testing.T, index, root string, extra ...string) map[string]any {
		return runPlanWithPlatform(t, index, root, []string{"--platform-version", "3.2.0"}, extra...)
	}
	assertDetails := func(t *testing.T, failure map[string]any, kind, id, version, requiredRange, hint string) {
		t.Helper()
		details, ok := failure["details"].(map[string]any)
		if !ok || details["kind"] != kind || details["id"] != id || details["selectedVersion"] != version || details["requiredRange"] != requiredRange {
			t.Fatalf("error details = %#v, want kind=%q id=%q selectedVersion=%q requiredRange=%q", failure["details"], kind, id, version, requiredRange)
		}
		if failure["hint"] != hint {
			t.Fatalf("error hint = %#v, want %q", failure["hint"], hint)
		}
	}

	t.Run("S-053.4 explicit adapter range", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "adapter-range-root")
		failure := runPlan(t, matrix, root, "--adapters", "fixture-adapter@1.0.0")
		assertDetails(t, failure, "adapter", "fixture-adapter", "3.2.0", "<3.2.0",
			"Choose compatible versions or pass an explicit supported provider.")
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("incompatible adapter plan changed install root: %v", err)
		}
	})

	t.Run("S-053.5 missing binary identity", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "missing-binary-root")
		failure := runPlan(t, missingBinary, root)
		assertDetails(t, failure, "binary", "kb-create", "3.2.0", "",
			"Choose compatible versions or pass an explicit supported provider.")
		details, ok := failure["details"].(map[string]any)
		if !ok || details["target"] != fixtureOS+"/"+arch {
			t.Fatalf("missing binary target = %#v, want %s", failure["details"], fixtureOS+"/"+arch)
		}
	})
	t.Run("S-053.5 out-of-range SDK", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "sdk-range-root")
		args := []string{"--sdk-version", "4.0.0"}
		failure := runPlan(t, matrix, root, args...)
		assertDetails(t, failure, "sdk", "sdk", "4.0.0", ">=3.0.0 <4.0.0",
			"Choose compatible versions or pass an explicit supported provider.")
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("out-of-range SDK plan changed install root: %v", err)
		}
	})

	t.Run("S-053.7 missing binary leaves isolated root absent", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "missing-binary-root")
		failure := runPlan(t, missingBinary, root)
		assertDetails(t, failure, "binary", "kb-create", "3.2.0", "",
			"Choose compatible versions or pass an explicit supported provider.")
		details, ok := failure["details"].(map[string]any)
		if !ok || details["target"] != fixtureOS+"/"+arch {
			t.Fatalf("missing binary target = %#v, want %s", failure["details"], fixtureOS+"/"+arch)
		}
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("missing binary refusal changed isolated install root: %v", err)
		}
	})

	t.Run("S-053.8 companion SDK range from explicit platform version", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "plugin-sdk-range-explicit")
		failure := runPlanWithPlatform(t, matrix, root, []string{"--platform-version", "3.2.0"}, "--plugins", "fixture-sdk-incompat@1.0.0")
		assertDetails(t, failure, "plugin", "fixture-sdk-incompat", "3.0.0", "<3.0.0",
			"Choose compatible versions or pass an explicit supported provider.")
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("incompatible plugin SDK range changed install root: %v", err)
		}
	})
	t.Run("S-053.8 companion SDK range from platform channel", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "plugin-sdk-range-channel")
		failure := runPlanWithPlatform(t, matrix, root, []string{"--platform-channel", "stable"}, "--plugins", "fixture-sdk-incompat@1.0.0")
		assertDetails(t, failure, "plugin", "fixture-sdk-incompat", "3.0.0", "<3.0.0",
			"Choose compatible versions or pass an explicit supported provider.")
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Fatalf("incompatible plugin SDK range changed install root: %v", err)
		}
	})
}

// case: PC-001.10, PC-001.16
func TestBuiltCLIAllocatesAndRetainsSecondaryGatewayOffsets(t *testing.T) {
	launcher, _ := binaries(t)
	home := t.TempDir()
	rootDir := t.TempDir()
	rootA := filepath.Join(rootDir, "root-a")
	rootB := filepath.Join(rootDir, "root-b")
	rootC := filepath.Join(rootDir, "root-c")
	rootD := filepath.Join(rootDir, "root-d")
	writeVersionedReceipt(t, rootA, contracts.InstallReceipt{ID: "registered-gateway-root",
		Plan: contracts.ResolvedInstallPlan{Host: &contracts.HostSpec{HealthURL: "http://127.0.0.1:4000/health"},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}})
	registry := gateway.Registry{Path: gateway.RegistryPath(home)}
	if err := registry.Writer(gateway.Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}

	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {
		PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: 4000}},
	}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "platform.adapterOptions", Path: "/platform/adapterOptions",
		Default: `{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:4000"}}}}`}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(home, "release-index.json")
	encoded, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	plan := func(t *testing.T, root, explicitURL string) contracts.ResolvedInstallPlan {
		t.Helper()
		args := []string{"plan", "--json", "--index", indexPath, "--platform-root", root}
		if explicitURL != "" {
			args = append(args, "--gateway-url", explicitURL)
		}
		command := exec.Command(launcher, args...)
		command.Env = childEnvironment(os.Environ(), map[string]string{"HOME": home,
			"KB_PLATFORM_ROOT": "", "KB_HOME": "", "KB_NET_OFFSET": "", "XDG_DATA_HOME": ""})
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("built kb-create plan %s: %v\n%s", root, err, output)
		}
		var envelope struct {
			Data struct {
				Plan contracts.ResolvedInstallPlan `json:"plan"`
			} `json:"data"`
		}
		if err := json.Unmarshal(output, &envelope); err != nil {
			t.Fatalf("built kb-create plan output is invalid: %s (%v)", output, err)
		}
		return envelope.Data.Plan
	}
	registerAppliedRoot := func(root string, plan contracts.ResolvedInstallPlan) {
		writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "registered-" + filepath.Base(root), Plan: plan})
		origin, err := gateway.OriginFromHealthURL(plan.Host.HealthURL)
		if err != nil {
			t.Fatal(err)
		}
		if err := registry.Writer(gateway.Apply).Register(root, origin); err != nil {
			t.Fatal(err)
		}
	}

	planB := plan(t, rootB, "")
	if planB.Host.HealthURL != "http://127.0.0.1:4100/health" || planB.ServiceGraph.Services[0].Port != 4100 {
		t.Fatalf("root B plan did not receive the next 100-port offset: %#v", planB)
	}
	registerAppliedRoot(rootB, planB)

	planC := plan(t, rootC, "http://127.0.0.1:4200")
	if planC.Host.HealthURL != "http://127.0.0.1:4200/health" {
		t.Fatalf("explicit root C Gateway was not preserved in its plan: %#v", planC)
	}
	registerAppliedRoot(rootC, planC)

	planD := plan(t, rootD, "")
	if planD.Host.HealthURL != "http://127.0.0.1:4300/health" || planD.ServiceGraph.Services[0].Port != 4300 {
		t.Fatalf("root D plan did not advance past stopped roots: %#v", planD)
	}
	if retained := plan(t, rootB, ""); retained.Host.HealthURL != planB.Host.HealthURL ||
		retained.ServiceGraph.Services[0].Port != planB.ServiceGraph.Services[0].Port {
		t.Fatalf("replanning root B changed its Gateway allocation: %#v", retained)
	}
}

func childEnvironment(base []string, overrides map[string]string) []string {
	env := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if key == "HOME" || key == "GOFLAGS" || strings.HasPrefix(key, "KB_") {
			continue
		}
		if _, overridden := overrides[key]; overridden {
			continue
		}
		env = append(env, entry)
	}
	for key, value := range overrides {
		if value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func TestChildEnvironmentClearsAmbientHomePlatformInputsAndGoFlags(t *testing.T) {
	home := t.TempDir()
	kbHome := t.TempDir()
	envPath, err := exec.LookPath("env")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(envPath)
	command.Env = childEnvironment([]string{
		"HOME=/ambient/home", "KB_HOME=/ambient/kb", "KB_PLATFORM_ROOT=/ambient/root",
		"KB_NET_OFFSET=900", "KB_SECRET_SENTINEL=secret", "GOFLAGS=-mod=vendor", "PATH=" + os.Getenv("PATH"),
	}, map[string]string{"HOME": home, "KB_HOME": kbHome})
	output, err := command.Output()
	if err != nil {
		t.Fatalf("read isolated child environment: %v", err)
	}
	values := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = value
		}
	}
	if values["HOME"] != home || values["KB_HOME"] != kbHome {
		t.Fatalf("child HOME/KB_HOME = %q/%q, want fixture paths %q/%q", values["HOME"], values["KB_HOME"], home, kbHome)
	}
	for _, key := range []string{"KB_PLATFORM_ROOT", "KB_NET_OFFSET", "KB_SECRET_SENTINEL", "GOFLAGS"} {
		if _, exists := values[key]; exists {
			t.Errorf("child environment retained %s", key)
		}
	}
}

func TestInstallationSubprocessHelpersUseSanitizedEnvironment(t *testing.T) {
	inst := newInstallation(t)
	for key, value := range map[string]string{
		"KB_PLATFORM_ROOT": "/ambient/root", "KB_NET_OFFSET": "900", "KB_TEST_SECRET": "ambient-secret", "GOFLAGS": "-mod=vendor",
	} {
		t.Setenv(key, value)
	}
	t.Setenv("HOME", "/ambient/home")
	t.Setenv("KB_HOME", "/ambient/kb-home")
	result := inst.runArgv([]string{"env"}, "KB_TEST_INPUT=fixture-value")
	if result.code != 0 {
		t.Fatalf("inspect installation helper environment: code=%d output=%s", result.code, result.output)
	}
	values := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(result.output), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = value
		}
	}
	if values["HOME"] != inst.home || values["KB_HOME"] != inst.kbHome || values["KB_TEST_INPUT"] != "fixture-value" {
		t.Fatalf("fixture child environment = %#v; want fixture HOME/KB_HOME and explicit test input", values)
	}
	for _, key := range []string{"KB_PLATFORM_ROOT", "KB_NET_OFFSET", "KB_TEST_SECRET", "GOFLAGS"} {
		if _, exists := values[key]; exists {
			t.Errorf("installation helper child inherited %s", key)
		}
	}
}

var (
	buildOnce                sync.Once
	buildDir                 string
	buildErr                 error
	hostSupervisorHelperOnce sync.Once
	hostSupervisorHelperErr  error
)

// binaries builds the real launcher and the fake host once per test binary.
func binaries(t *testing.T) (launcher, fakehost string) {
	t.Helper()
	buildOnce.Do(func() {
		buildDir, buildErr = os.MkdirTemp("", "kb-create-cli-")
		if buildErr != nil {
			return
		}
		for name, pkg := range map[string]string{"kb-create": "../../..", "fakehost": "../../internal/fakehost"} {
			if output, err := exec.Command("go", "build", "-o", filepath.Join(buildDir, name), pkg).CombinedOutput(); err != nil {
				buildErr = fmt.Errorf("build %s: %v\n%s", name, err, output)
				return
			}
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	t.Cleanup(func() { _ = os.Remove(filepath.Join(buildDir, "kb")) })
	return filepath.Join(buildDir, "kb-create"), filepath.Join(buildDir, "fakehost")
}

func hostSupervisorHelperBinary(t *testing.T) string {
	t.Helper()
	binaries(t)
	hostSupervisorHelperOnce.Do(func() {
		output, err := exec.Command("go", "build", "-tags", "kb_create_test_support", "-o", filepath.Join(buildDir, "kb-create-supervisor.test"), "../../testsupport/identity-supervisor").CombinedOutput()
		if err != nil {
			hostSupervisorHelperErr = fmt.Errorf("build host test supervisor helper: %w\n%s", err, output)
		}
	})
	if hostSupervisorHelperErr != nil {
		t.Fatal(hostSupervisorHelperErr)
	}
	return filepath.Join(buildDir, "kb-create-supervisor.test")
}

func TestMain(m *testing.M) {
	checkLeakedTempEntries := tempdirguard.Own("kb-create-cli-")
	code := m.Run()
	if buildDir != "" {
		binaries := []struct{ name, path string }{
			{name: "kb-create launcher", path: filepath.Join(buildDir, "kb-create")},
			{name: "kb-create supervisor", path: filepath.Join(buildDir, "kb-create")},
			{name: "fakehost", path: filepath.Join(buildDir, "fakehost")},
			{name: "test supervisor helper", path: filepath.Join(buildDir, "kb-create-supervisor.test")},
		}
		for _, process := range binaries {
			if _, err := os.Stat(process.path); os.IsNotExist(err) {
				continue
			}
			output, err := exec.Command("lsof", "-nP", "-t", process.path).CombinedOutput()
			if err == nil && len(bytes.TrimSpace(output)) > 0 {
				fmt.Fprintf(os.Stderr, "test process remains alive for %s (%s):\n%s", process.name, process.path, output)
				code = 1
			} else if err != nil {
				if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 || len(bytes.TrimSpace(output)) != 0 {
					fmt.Fprintf(os.Stderr, "could not audit test process path %s (%s): %v\n%s", process.name, process.path, err, output)
					code = 1
				} else {
					fmt.Fprintf(os.Stdout, "process audit %s (%s): none\n", process.name, process.path)
				}
			} else {
				fmt.Fprintf(os.Stdout, "process audit %s (%s): none\n", process.name, process.path)
			}
		}
	}
	if buildDir != "" {
		os.RemoveAll(buildDir)
	}
	if leaked := checkLeakedTempEntries(); len(leaked) > 0 {
		fmt.Fprintf(os.Stderr, "kb-create-v2 tests left their own temp entries in %s: %v; entries with this prefix must be removed by the suite that created them\n", os.TempDir(), leaked)
		code = 1
	}
	os.Exit(code)
}

type installation struct {
	launcher, root, home, kbHome, state string
	port                                int
	t                                   *testing.T
}

func newInstallation(t *testing.T, hostArgs ...string) installation {
	t.Helper()
	launcher, fakehost := binaries(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return newInstallationWithRoot(t, launcher, fakehost, t.TempDir(), t.TempDir(), port, hostArgs...)
}

func newInstallationWithRoot(t *testing.T, launcher, fakehost, root, kbHome string, port int, hostArgs ...string) installation {
	t.Helper()
	spec := &contracts.HostSpec{Command: fakehost, Args: append([]string{"-port", fmt.Sprint(port)}, hostArgs...), HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: spec,
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway", Command: "gateway"}}}}
	fixtureCatalog, err := sealTestCatalog(t, testReleaseCatalog(t, "1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	plan.ReleaseCatalog, err = json.Marshal(fixtureCatalog)
	if err != nil {
		t.Fatal(err)
	}
	writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "r1", InstallationID: "installation-r1", Plan: plan})
	registerTestHostProcessTreeCleanup(t, root)
	if err := os.WriteFile(filepath.Join(root, "state", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.KBHomeEnv, kbHome)
	home := t.TempDir()
	state, err := host.StateHome(root)
	if err != nil {
		t.Fatal(err)
	}
	inst := installation{launcher: launcher, root: root, home: home, kbHome: kbHome, state: state.Dir, port: port, t: t}
	return inst
}

func newEmptyInstallation(t *testing.T) installation {
	t.Helper()
	launcher, _ := binaries(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	root := t.TempDir()
	kbHome := t.TempDir()
	home := t.TempDir()
	t.Setenv(host.KBHomeEnv, kbHome)
	state, err := host.StateHome(root)
	if err != nil {
		t.Fatal(err)
	}
	inst := installation{launcher: launcher, root: root, home: home, kbHome: kbHome, state: state.Dir, port: port, t: t}
	registerTestHostProcessTreeCleanup(t, root)
	return inst
}

func (i installation) run(args ...string) (map[string]any, int, string) {
	return i.runAt(i.root, args...)
}

func (i installation) runAt(root string, args ...string) (map[string]any, int, string) {
	command := exec.Command(i.launcher, append(args, "--platform-root", root)...)
	command.Env = i.childEnvironment()
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	}
	var parsed map[string]any
	_ = json.Unmarshal(stdout.Bytes(), &parsed)
	if data, ok := parsed["data"].(map[string]any); ok {
		parsed = data
	}
	return parsed, code, stdout.String() + stderr.String()
}

// case: PC-001.7, PC-002.2
func TestStatusUsesOneInstallationIdentityAcrossRootSpellings(t *testing.T) {
	inst := newInstallation(t)
	started, code, output := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start host: %d %s", code, output)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	physicalRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{inst.root, layout.PlatformRoot(), physicalRoot} {
		status, statusCode, statusOutput := inst.runAt(root, "status", "--json")
		if statusCode != 0 || status["running"] != true || status["reachable"] != true {
			t.Fatalf("status for %q after PID %v started: code=%d output=%s", root, started["host"].(map[string]any)["pid"], statusCode, statusOutput)
		}
	}
}

func (i installation) runCommand(args []string, extraEnv ...string) commandResult {
	return i.runArgv(append([]string{i.launcher}, args...), extraEnv...)
}

func (i installation) runArgv(argv []string, extraEnv ...string) commandResult {
	if len(argv) == 0 {
		i.t.Fatal("cannot run an empty argv")
	}
	program := argv[0]
	if program == "kb-create" {
		program = i.launcher
	}
	command := exec.Command(program, argv[1:]...)
	command.Env = i.childEnvironment(extraEnv...)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	}
	output := stdout.String() + stderr.String()
	var payload map[string]any
	_ = json.Unmarshal(stdout.Bytes(), &payload)
	if data, ok := payload["data"].(map[string]any); ok {
		payload = data
	}
	return commandResult{payload: payload, code: code, output: output}
}

func (i installation) childEnvironment(extraEnv ...string) []string {
	home := i.home
	if home == "" {
		home = i.t.TempDir()
	}
	kbHome := i.kbHome
	if kbHome == "" {
		kbHome = i.t.TempDir()
	}
	overrides := map[string]string{
		"HOME": home, "KB_HOME": kbHome,
		"PATH": filepath.Dir(i.launcher) + string(os.PathListSeparator) + os.Getenv("PATH"),
	}
	for _, entry := range extraEnv {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			overrides[key] = value
		}
	}
	return childEnvironment(os.Environ(), overrides)
}

func waitHostExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for host.ProcessAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	return !host.ProcessAlive(pid)
}

func errorCode(payload map[string]any) string {
	if failure, ok := payload["error"].(map[string]any); ok {
		code, _ := failure["code"].(string)
		return code
	}
	return ""
}

func TestHostLifecycleThroughTheLauncher(t *testing.T) {
	inst := newInstallation(t)

	started, code, raw := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start: %d %s", code, raw)
	}
	pid := started["host"].(map[string]any)["pid"].(float64)

	rootState, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(rootState.Dir, "control.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("control.json: %v %v", info, err)
	}

	again, code, raw := inst.run("start", "--json")
	if code != 1 || errorCode(again) != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("second start: %d %s", code, raw)
	}

	status, code, raw := inst.run("status", "--json")
	hostInfo := status["host"].(map[string]any)
	if code != 0 || hostInfo["state"] != "running" || hostInfo["pid"].(float64) != pid {
		t.Fatalf("status: %d %s", code, raw)
	}
	doctor, doctorCode, doctorOutput := inst.run("doctor", "--json")
	retention, _ := doctor["retention"].(map[string]any)
	stateForDoctor, err := host.StateForRoot(inst.root)
	if err != nil || doctorCode != 0 || retention["hostState"] != stateForDoctor.Dir || retention["installRoot"] == "" ||
		retention["platformRoot"] == "" || retention["versionsDirectory"] == "" ||
		retention["sharedState"] == "" || retention["installerState"] == "" {
		t.Fatalf("doctor did not report container paths: code=%d retention=%#v output=%s", doctorCode, retention, doctorOutput)
	}

	restarted, code, raw := inst.run("restart", "--json")
	if code != 0 || restarted["host"].(map[string]any)["pid"].(float64) == pid {
		t.Fatalf("restart must replace the host process: %d %s", code, raw)
	}
	statusAfterRestart, statusCode, statusRaw := inst.run("status", "--json")
	if statusCode != 0 || statusAfterRestart["host"].(map[string]any)["state"] != "running" {
		t.Fatalf("status after restart: %d %s", statusCode, statusRaw)
	}

	stopped, code, raw := inst.run("stop", "--json")
	result, _ := stopped["stopped"].(map[string]any)
	if code != 0 || result["wasRunning"] != true || result["graceful"] != true || result["forced"] == true {
		t.Fatalf("stop: %d %s", code, raw)
	}
	if _, err := os.Stat(filepath.Join(rootState.Dir, "control.json")); !os.IsNotExist(err) {
		t.Fatal("control.json must be gone after stop")
	}
	status, code, _ = inst.run("status", "--json")
	if code != 0 || status["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("status after stop: %v", status)
	}
	idle, code, _ := inst.run("stop", "--json")
	if code != 0 || idle["stopped"].(map[string]any)["wasRunning"] != false {
		t.Fatalf("stopping an idle host must succeed: %v", idle)
	}
}

func TestRestartRefusesActiveWorkBeforeStoppingUnlessInterrupted(t *testing.T) {
	inst := newInstallation(t, "-active-work-json", `[{"kind":"workflow","id":"run-23","owningService":"workflow"}]`)
	started, code, output := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start host: code=%d output=%s", code, output)
	}
	pid := started["host"].(map[string]any)["pid"].(float64)
	refused, code, output := inst.run("restart", "--json")
	if code != 1 || errorCode(refused) != "KB_RESTART_WORK_IN_FLIGHT" {
		t.Fatalf("restart with active work: code=%d payload=%#v output=%s", code, refused, output)
	}
	failure := refused["error"].(map[string]any)
	details := failure["details"].(map[string]any)
	items := details["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["owningService"] != "workflow" {
		t.Fatalf("active-work diagnostic details = %#v", details)
	}
	status, statusCode, statusOutput := inst.run("status", "--json")
	if statusCode != 0 || status["host"].(map[string]any)["pid"].(float64) != pid {
		t.Fatalf("host after refusal: %#v %s", status, statusOutput)
	}
	interrupted, code, output := inst.run("restart", "--interrupt", "--json")
	if code != 0 || interrupted["host"].(map[string]any)["pid"].(float64) == pid {
		t.Fatalf("explicit interrupt did not replace host: code=%d payload=%#v output=%s", code, interrupted, output)
	}
}

func TestRestartControlUnavailableReturnsHostUnreachableWithoutStoppingHost(t *testing.T) {
	inst := newInstallation(t)
	started, code, output := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start host: code=%d output=%s", code, output)
	}
	pid := started["host"].(map[string]any)["pid"].(float64)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(state.Control()); err != nil {
		t.Fatal(err)
	}
	restarted, code, output := inst.run("restart", "--json")
	if code != 1 || errorCode(restarted) != "KB_HOST_UNREACHABLE" {
		t.Fatalf("restart without supervisor channel: code=%d payload=%#v output=%s", code, restarted, output)
	}
	status, statusCode, statusOutput := inst.run("status", "--json")
	hostStatus := status["host"].(map[string]any)
	if statusCode != 0 || hostStatus["state"] != "running" || hostStatus["pid"].(float64) != pid {
		t.Fatalf("host after unreachable restart: code=%d status=%#v output=%s", statusCode, hostStatus, statusOutput)
	}
}

// case: S-223.5
func TestStatusAndStopUseTheDurableHostRecordWhenLayoutMetadataIsUnreadable(t *testing.T) {
	inst := newInstallation(t)
	started, code, output := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start: %d %s", code, output)
	}
	pid := int(started["host"].(map[string]any)["pid"].(float64))
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(filepath.Dir(state.Dir), "layout.json")
	if err := os.WriteFile(metadata, []byte("not valid layout metadata\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, code, output := inst.run("status", "--json")
	if code != 0 || status["running"] != true || status["host"].(map[string]any)["pid"].(float64) != float64(pid) {
		t.Fatalf("status did not read the durable host record: code=%d payload=%#v output=%s", code, status, output)
	}
	stopped, code, output := inst.run("stop", "--json")
	result, _ := stopped["stopped"].(map[string]any)
	if code != 0 || result["wasRunning"] != true {
		t.Fatalf("stop did not reach the recorded process: code=%d payload=%#v output=%s", code, stopped, output)
	}
	if !waitHostExit(pid, 5*time.Second) {
		t.Fatalf("recorded host process %d is still running after stop", pid)
	}
}

// case: S-025.7, S-025.8, PC-001.10, PC-001.12
func TestIndependentPlatformRootsOwnTheirHostLifecycle(t *testing.T) {
	inst := newInstallation(t)
	if _, code, output := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start A: %d %s", code, output)
	}
	receiptAPath := receipt.Path(platformRootForTest(t, inst.root))
	receiptABefore, err := os.ReadFile(receiptAPath)
	if err != nil {
		t.Fatal(err)
	}
	rootB := t.TempDir()
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.Request.PlatformRoot = filepath.Join(rootB, "current")
	portB := freeLoopbackPort(t)
	active.Plan.Host.Args = append([]string(nil), active.Plan.Host.Args...)
	active.Plan.Host.Args[1] = fmt.Sprint(portB)
	active.Plan.Host.HealthURL = fmt.Sprintf("http://127.0.0.1:%d/health", portB)
	writeVersionedReceipt(t, rootB, active)
	if err := os.WriteFile(filepath.Join(rootB, "state", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	fixValue, fixFailure, code, _ := executeForTest(t, operationTestSetup{Operation: "doctor", PlatformRoot: rootB, Fix: true, JSON: true})
	if code != 0 || fixFailure != nil {
		t.Fatalf("doctor --fix B: %d %#v", code, fixFailure)
	}
	fixResult := fixValue.(doctorFixResult)
	if fixResult.HostRestarted {
		t.Fatalf("doctor --fix B reported a restart: %#v", fixResult)
	}
	statusB := runForRoot(t, inst, rootB, "status")
	if statusB["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("status B observed A's host: %#v", statusB)
	}

	startB := runForRoot(t, inst, rootB, "start")
	if startB["ok"] != true || startB["operation"] != "start" {
		t.Fatalf("independent root B did not start beside A: %#v", startB)
	}
	statusBRunning := runForRoot(t, inst, rootB, "status")
	if statusBRunning["host"].(map[string]any)["state"] != "running" {
		t.Fatalf("B did not report its own host as running: %#v", statusBRunning)
	}
	stopB := runForRoot(t, inst, rootB, "stop")
	if stopB["ok"] != true {
		t.Fatalf("B stop failed: %#v", stopB)
	}
	statusA, code, output := inst.run("status", "--json")
	if code != 0 || statusA["host"].(map[string]any)["state"] != "running" {
		t.Fatalf("A was affected by B operations: %d %s", code, output)
	}
	if _, code, output = inst.run("restart", "--json"); code != 0 {
		t.Fatalf("restart A after B operations: %d %s", code, output)
	}
	receiptAAfter, err := os.ReadFile(receiptAPath)
	if err != nil || !bytes.Equal(receiptAAfter, receiptABefore) {
		t.Fatalf("operations on B changed A's receipt: err=%v", err)
	}
}

func runForRoot(t *testing.T, inst installation, root, operation string) map[string]any {
	t.Helper()
	inst.t = t
	command := exec.Command(inst.launcher, operation, "--platform-root", root, "--json")
	command.Env = inst.childEnvironment()
	output, err := command.CombinedOutput()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(output, &envelope); err != nil {
		t.Fatalf("%s result is not JSON (exit %d): %v %s", operation, code, err, output)
	}
	if data, ok := envelope["data"].(map[string]any); ok {
		if code == 0 && operation == "start" {
			pid := 0
			if hostStatus, ok := data["host"].(map[string]any); ok {
				if value, ok := hostStatus["pid"].(float64); ok {
					pid = int(value)
				}
			}
			t.Cleanup(func() {
				stopped := runForRoot(t, inst, root, "stop")
				if stopped["ok"] != true || (pid != 0 && !waitHostExit(pid, 5*time.Second)) {
					t.Errorf("cleanup did not stop root %s cleanly: %#v", root, stopped)
				}
			})
		}
		return data
	}
	envelope["code"] = float64(code)
	return envelope
}

// case: S-025.1, S-025.2, S-203.10
func TestStatusAndDoctorReportReceiptChannelAndExactVersion(t *testing.T) {
	inst := newInstallation(t)
	active := contracts.InstallReceipt{ID: "receipt-canary", InstallationID: "installation-r1", Plan: contracts.ResolvedInstallPlan{
		Schema: contracts.ResolvedPlanSchema, PlatformChannel: "canary",
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "3.2.0-canary.4"},
		Host:         &contracts.HostSpec{Command: inst.launcher, HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", inst.port)},
	}}
	installationID, err := versionroot.InstallationIDForPath(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	active.InstallationID = installationID
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}

	status, _, statusOutput := inst.run("status", "--json")
	installation, ok := status["installation"].(map[string]any)
	if !ok || installation["platformChannel"] != "canary" || installation["platformVersion"] != "3.2.0-canary.4" {
		t.Fatalf("status installation = %v; output %s", status["installation"], statusOutput)
	}
	_, _, statusText := inst.run("status")
	if !strings.Contains(statusText, "Platform channel: canary") || !strings.Contains(statusText, "Platform version: 3.2.0-canary.4") {
		t.Fatalf("status text omitted release identity: %s", statusText)
	}

	doctor, doctorCode, doctorOutput := inst.run("doctor", "--json")
	doctorInstallation, doctorOK := doctor["installation"].(map[string]any)
	if doctorCode != 0 || !doctorOK || doctor["operation"] != "doctor" || doctor["status"] != "unhealthy" || doctor["platformChannel"] != "canary" || doctor["platformVersion"] != "3.2.0-canary.4" || doctorInstallation["ok"] != false {
		t.Fatalf("doctor omitted successful unhealthy report or release identity: %v; output %s", doctor, doctorOutput)
	}
	_, doctorCode, doctorOutput = inst.run("doctor")
	if doctorCode != 0 || !strings.Contains(doctorOutput, "Platform diagnosis completed.") || !strings.Contains(doctorOutput, "unhealthy") || !strings.Contains(doctorOutput, "Platform check host-process") {
		t.Fatalf("human doctor output omitted report status or installation finding: %d %s", doctorCode, doctorOutput)
	}
}

func TestStartReportsPortInUse(t *testing.T) {
	inst := newInstallation(t)
	blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", inst.port))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	payload, code, raw := inst.run("start", "--json")
	if code != 1 || errorCode(payload) != "KB_INSTALL_PORT_IN_USE" {
		t.Fatalf("start: %d %s", code, raw)
	}
}

// case: S-025.8, PC-001.9
func TestPrintedStopCommandWorksForShellSpecialRoot(t *testing.T) {
	launcher, fakehost := binaries(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	kbHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", kbHome)
	rootA := filepath.Join(t.TempDir(), "KB Labs ' $ROOT `tick`\nline")
	rootB := filepath.Join(t.TempDir(), "secondary")
	a := newInstallationWithRoot(t, launcher, fakehost, rootA, kbHome, port)
	b := newInstallationWithRoot(t, launcher, fakehost, rootB, kbHome, port)
	if _, code, output := a.run("start", "--json"); code != 0 {
		t.Fatalf("start platform A: %d %s", code, output)
	}
	t.Cleanup(func() { _, _, _ = a.run("stop", "--json") })
	layoutA, err := versionroot.New(rootA)
	if err != nil {
		t.Fatal(err)
	}
	activeReceiptRoot := layoutA.PlatformRoot()
	if err := (gateway.Registry{Path: filepath.Join(kbHome, "kb-create", "gateway-roots.json")}).Writer(gateway.Apply).Register(activeReceiptRoot, fmt.Sprintf("http://127.0.0.1:%d", port)); err != nil {
		t.Fatal(err)
	}
	if _, err := receipt.Read(activeReceiptRoot); err != nil {
		t.Fatalf("registered active receipt root %s is unreadable: %v", activeReceiptRoot, err)
	}
	rootState, err := host.StateForRoot(activeReceiptRoot)
	if err != nil {
		t.Fatal(err)
	}
	processRecord, err := os.ReadFile(rootState.HostPID())
	if err != nil {
		t.Fatalf("active host record %s is unreadable: %v", rootState.HostPID(), err)
	}
	var recorded struct {
		PID             int    `json:"pid"`
		ProcessIdentity string `json:"processIdentity"`
		InstallationID  string `json:"installationId"`
		PlatformRoot    string `json:"platformRoot"`
	}
	if err := json.Unmarshal(processRecord, &recorded); err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(layoutA.InstallRoot())
	if err != nil || recorded.InstallationID != installationID {
		t.Fatalf("record installation identity %q differs from layout identity %q: %v", recorded.InstallationID, installationID, err)
	}
	if filepath.Clean(recorded.PlatformRoot) != filepath.Clean(activeReceiptRoot) {
		t.Fatalf("active record root %q differs from registered root %q", recorded.PlatformRoot, activeReceiptRoot)
	}
	if host.ProcessIdentityOf(recorded.PID, recorded.ProcessIdentity) != host.ProcessIdentityMatch {
		t.Fatalf("registered host PID %d does not match its recorded identity", recorded.PID)
	}
	payload, code, output := b.run("start", "--json")
	if code != 1 || errorCode(payload) != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("start platform B: %d %s", code, output)
	}
	hint, _ := payload["error"].(map[string]any)["hint"].(string)
	commandText := strings.TrimPrefix(hint, "Use `")
	commandText = strings.TrimSuffix(commandText, "` to inspect or stop the already-running host.")
	commands, err := contracts.ParseShellCommands(commandText)
	want := []string{"kb-create", "stop", "--platform-root", layoutA.InstallRoot()}
	if err != nil || len(commands) != 1 || !reflect.DeepEqual(commands[0], want) {
		t.Fatalf("printed stop command does not preserve root: %#v, %v", commands, err)
	}
	command := exec.Command("/bin/sh", "-c", commandText+" --json")
	command.Env = a.childEnvironment()
	stopped, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("execute printed stop command: %v\n%s", err, stopped)
	}
	status, statusCode, statusOutput := a.run("status", "--json")
	if statusCode != 0 || status["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("printed stop command did not stop platform A: %d %s", statusCode, statusOutput)
	}
}

func TestRestartDiagnosesOldSupervisorRecordWithoutSignallingItsReusedPID(t *testing.T) {
	identity, err := host.NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.ProcessIdentityEnv, identity)
	inst := newInstallation(t)
	started, code, output := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start host: %d %s", code, output)
	}
	t.Cleanup(func() { _, _, _ = inst.run("stop", "--json") })
	hostPID := int(started["host"].(map[string]any)["pid"].(float64))
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	originalSupervisorRecord, err := os.ReadFile(state.SupervisorPID())
	if err != nil {
		t.Fatalf("read active supervisor record: %v", err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(state.SupervisorPID(), originalSupervisorRecord, 0o600); err != nil {
			t.Errorf("restore active supervisor record: %v", err)
		}
	})
	// The x26 record had a process identity but no installation identity.
	oldRecord, err := json.Marshal(map[string]any{"pid": os.Getpid(), "processIdentity": identity, "platformRoot": inst.root})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.SupervisorPID(), oldRecord, 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, code, output := inst.run("restart", "--json")
	if code != 1 || errorCode(restarted) != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("restart did not diagnose the old supervisor record: %d %s", code, output)
	}
	status, code, output := inst.run("status", "--json")
	if code != 1 || errorCode(status) != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("status did not diagnose the old supervisor record: %d %s", code, output)
	}
	if !host.ProcessAlive(os.Getpid()) {
		t.Fatal("restart signalled the process whose PID was reused")
	}
	if !host.ProcessAlive(hostPID) {
		t.Fatal("restart stopped the genuine host while rejecting the stale supervisor")
	}
}

func TestSupervisorIdentityTimeoutTerminatesAndReapsChild(t *testing.T) {
	inst := newInstallation(t)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner.Spec.ReadyTimeout = 100 * time.Millisecond
	launcher := filepath.Join(t.TempDir(), "supervisor-launcher")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	childPID := 0
	command := hostCommand{PlatformRoot: inst.root, Executable: launcher, testBackstopGrace: 100 * time.Millisecond,
		identityReader: func(pid int) (string, error) {
			childPID = pid
			return "", errors.New("injected process environment unavailable")
		}}
	_, err = command.spawnSupervisor(context.Background(), runner, state)
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_START_FAILED" || typed.Meta["waited"] == nil {
		t.Fatalf("supervisor identity timeout = %#v; want typed elapsed startup failure", err)
	}
	if childPID == 0 || host.ProcessAlive(childPID) {
		t.Fatalf("supervisor child PID %d remains alive after failed start", childPID)
	}
	if _, statErr := os.Stat(state.SupervisorPID()); !os.IsNotExist(statErr) {
		t.Fatalf("supervisor pid file must be absent after failed start: %v", statErr)
	}
}

func TestDetachedStartReadinessFailureCleansUpChildProcesses(t *testing.T) {
	inst := newInstallation(t, "-unhealthy")
	setHostReadyTimeout(t, inst, 5)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	var hostPID, supervisorPID int
	watchDone := make(chan struct{})
	watchStopped := make(chan struct{})
	go func() {
		defer close(watchStopped)
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			if record, ok := host.ActiveHost(state); ok {
				hostPID = record.PID
			}
			if record, ok := supervisor.ReadRecord(state); ok {
				supervisorPID = record.PID
			}
			select {
			case <-watchDone:
				return
			case <-ticker.C:
			}
		}
	}()
	payload, code, output := inst.run("start", "--json")
	close(watchDone)
	<-watchStopped
	if code != 1 || errorCode(payload) != "KB_HOST_START_FAILED" {
		t.Fatalf("detached readiness failure: %d %s", code, output)
	}
	failure := payload["error"].(map[string]any)
	details := failure["details"].(map[string]any)
	if !strings.Contains(fmt.Sprint(failure["cause"]), "readiness check") || details["waited"] == nil ||
		!strings.Contains(fmt.Sprint(details["stderrTail"]), "fakehost: ready") ||
		details["readinessStatus"] != "500" {
		t.Fatalf("outer command hid the inner readiness diagnosis: %s", output)
	}
	waited, err := time.ParseDuration(fmt.Sprint(details["waited"]))
	if err != nil || waited < time.Second || waited > 6*time.Second {
		t.Fatalf("readiness startup waited = %q (%v), want elapsed time within the shared 5s startup budget", details["waited"], err)
	}
	if hostPID == 0 || supervisorPID == 0 || host.ProcessAlive(hostPID) || host.ProcessAlive(supervisorPID) {
		t.Fatalf("failed detached start left host PID %d or supervisor PID %d alive", hostPID, supervisorPID)
	}
	for _, path := range []string{state.HostPID(), state.SupervisorPID(), state.Control()} {
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("failed detached start left state file %s: %v", path, statErr)
		}
	}
	if conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", inst.port), 100*time.Millisecond); dialErr == nil {
		_ = conn.Close()
		t.Fatal("failed detached start left the host listener open")
	}
}

func TestDetachedStartHostIdentityTimeoutCleansUpChildProcesses(t *testing.T) {
	inst := newInstallation(t, "-stderr-line=API_TOKEN=fake-secret-token")
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner.Spec.ReadyTimeout = 8 * time.Second
	state := runner.State
	helperBinary := hostSupervisorHelperBinary(t)
	hostPIDFile := filepath.Join(t.TempDir(), "host.pid")
	t.Setenv("TEST_HOST_PID_FILE", hostPIDFile)
	var supervisorPID int
	command := hostCommand{
		PlatformRoot: inst.root,
		Executable:   helperBinary,
		identityReader: func(pid int) (string, error) {
			supervisorPID = pid
			return host.ProcessIdentityForPID(pid)
		},
	}
	_, failure := command.start(context.Background(), runner, state)
	if failure == nil || failure.Code != "KB_HOST_START_FAILED" ||
		!strings.Contains(failure.Cause, "host process identity remained undetermined") ||
		strings.Contains(failure.Cause, "supervisor did not report") || failure.Meta["waited"] == nil {
		t.Fatalf("detached host identity timeout = %#v; want the inner typed identity failure with elapsed time", failure)
	}
	tail := fmt.Sprint(failure.Meta["stderrTail"])
	if !strings.Contains(tail, "fakehost: ready") || !strings.Contains(tail, "[REDACTED]") || strings.Contains(tail, "fake-secret-token") {
		hostLog, _ := os.ReadFile(state.HostLog())
		t.Fatalf("identity timeout stderr tail = %q; want ready line with secret redacted; diagnosis=%#v host log=%q", tail, failure, hostLog)
	}
	waited, err := time.ParseDuration(fmt.Sprint(failure.Meta["waited"]))
	if err != nil || waited < time.Second || waited > runner.Spec.ReadyTimeout {
		t.Fatalf("identity startup waited = %q (%v), want an elapsed wait within the shared 8s startup budget", failure.Meta["waited"], err)
	}
	data, err := os.ReadFile(hostPIDFile)
	if err != nil {
		t.Fatalf("host process identity seam did not record the launched PID: %v", err)
	}
	hostPID, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || hostPID <= 0 || host.ProcessAlive(hostPID) {
		t.Fatalf("launched host PID %q remains alive or is invalid: %v", data, err)
	}
	if supervisorPID <= 0 || host.ProcessAlive(supervisorPID) {
		t.Fatalf("supervisor PID %d remains alive after the inner identity verdict", supervisorPID)
	}
	assertDetachedStartStateEmpty(t, state, inst.port)
}

func TestDetachedStartReadyBeforeDeadlineSucceeds(t *testing.T) {
	inst := newInstallation(t, "-delay=2200ms")
	setHostReadyTimeout(t, inst, 6)
	started := time.Now()
	payload, code, output := inst.run("start", "--json")
	if code != 0 || payload["ok"] != true {
		t.Fatalf("host became ready before the startup deadline: %d %s", code, output)
	}
	if elapsed := time.Since(started); elapsed < 2*time.Second {
		t.Fatalf("delayed host returned in %s, expected the launch delay", elapsed)
	}
}

func TestDetachedStartUsesHandedDownDeadline(t *testing.T) {
	inst := newInstallation(t, "-unhealthy")
	setHostReadyTimeout(t, inst, 6)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	command := hostCommand{PlatformRoot: inst.root, Executable: inst.launcher, testBackstopGrace: 2 * time.Second}
	started := time.Now()
	_, err = command.spawnSupervisorUntil(context.Background(), runner, state, deadline)
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_START_FAILED" ||
		!strings.Contains(typed.Cause, "readiness check") || typed.Meta["waited"] == nil ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "fakehost: ready") {
		t.Fatalf("inner runner did not use the handed-down deadline: %#v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("inner runner took %s to honor the handed-down 3s deadline", elapsed)
	}
	assertDetachedStartStateEmpty(t, state, inst.port)
}

func TestDetachedStartHungSupervisorBackstopStopsHost(t *testing.T) {
	inst := newInstallation(t)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	var hostPID, supervisorPID int
	command := hostCommand{PlatformRoot: inst.root, Executable: inst.launcher, testBackstopGrace: 100 * time.Millisecond}
	command.testSupervisorHealthy = func(context.Context, host.State) bool {
		if record, ok := host.ActiveHost(state); ok {
			hostPID = record.PID
		}
		if record, ok := supervisor.ReadRecord(state); ok {
			supervisorPID = record.PID
		}
		return false
	}
	_, err = command.spawnSupervisorUntil(context.Background(), runner, state, time.Now().Add(5*time.Second))
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_START_FAILED" || typed.Meta["failureKind"] != "supervisorHung" {
		t.Fatalf("hung supervisor diagnosis = %#v; want distinct typed backstop failure", err)
	}
	if hostPID == 0 || supervisorPID == 0 || host.ProcessAlive(hostPID) || host.ProcessAlive(supervisorPID) {
		t.Fatalf("hung supervisor cleanup left host PID %d or supervisor PID %d alive", hostPID, supervisorPID)
	}
	assertDetachedStartStateEmpty(t, state, inst.port)
}

func TestDetachedStartSupervisorCrashReportsExitAndCleansUp(t *testing.T) {
	inst := newInstallation(t)
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(t.TempDir(), "supervisor-crash")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nprintf 'supervisor-crash-marker\\n' >&2\nexit 23\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	command := hostCommand{PlatformRoot: inst.root, Executable: launcher, testBackstopGrace: time.Second}
	_, err = command.spawnSupervisorUntil(context.Background(), runner, state, time.Now().Add(5*time.Second))
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_START_FAILED" ||
		typed.Meta["supervisorExit"] != "exit status 23" ||
		!strings.Contains(fmt.Sprint(typed.Meta["supervisorStderrTail"]), "supervisor-crash-marker") {
		t.Fatalf("supervisor crash diagnosis = %#v; want exit status and stderr tail", err)
	}
	assertDetachedStartStateEmpty(t, state, inst.port)
}

func assertDetachedStartStateEmpty(t *testing.T, state host.State, port int) {
	t.Helper()
	for _, path := range []string{state.HostPID(), state.SupervisorPID(), state.Control()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("failed detached start left state file %s: %v", path, err)
		}
	}
	if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Error("failed detached start left its host listener open")
	}
}

func setHostReadyTimeout(t *testing.T, inst installation, seconds int) {
	t.Helper()
	platformRoot := platformRootForTest(t, inst.root)
	active, err := receipt.Read(platformRoot)
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.Host.ReadyTimeoutSeconds = seconds
	if err := receipt.Write(platformRoot, active); err != nil {
		t.Fatal(err)
	}
}

func TestStaleLiveHostRecoveryEndsAtPortConflict(t *testing.T) {
	launcher, fakehost := binaries(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	kbHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", kbHome)
	rootA := filepath.Join(t.TempDir(), "platform A")
	rootB := filepath.Join(t.TempDir(), "platform B")
	a := newInstallationWithRoot(t, launcher, fakehost, rootA, kbHome, port)
	b := newInstallationWithRoot(t, launcher, fakehost, rootB, kbHome, port)
	if _, code, output := a.run("start", "--json"); code != 0 {
		t.Fatalf("start A: %d %s", code, output)
	}
	state, err := host.StateForRoot(rootA)
	if err != nil {
		t.Fatal(err)
	}
	layoutA, err := versionroot.New(rootA)
	if err != nil {
		t.Fatal(err)
	}
	if err := (gateway.Registry{Path: filepath.Join(kbHome, "kb-create", "gateway-roots.json")}).Writer(gateway.Apply).Register(
		layoutA.PlatformRoot(), fmt.Sprintf("http://127.0.0.1:%d", port)); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(state.HostPID())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := host.WriteRecordFile(state.HostPID(), original); err != nil {
			t.Errorf("restore host record for cleanup: %v", err)
		}
		_, _, _ = a.run("stop", "--json")
	})
	var record map[string]any
	if err := json.Unmarshal(original, &record); err != nil {
		t.Fatal(err)
	}
	record["processIdentity"] = "mismatched-process-identity"
	stale, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.HostPID(), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	status, code, output := a.run("status", "--json")
	if code != 1 || errorCode(status) != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("stale status: %d %s", code, output)
	}
	staleError := status["error"].(map[string]any)
	hint := staleError["hint"].(string)
	if !strings.Contains(staleError["message"].(string), "is running") || !strings.Contains(staleError["message"].(string), "will not signal") {
		t.Fatalf("stale diagnostic does not say the process is running: %#v", status["error"])
	}
	if !strings.Contains(hint, contracts.ShellCommand("curl", "--fail", "--show-error", "--max-time", "2")) ||
		!strings.Contains(hint, contracts.ShellCommand("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN")) ||
		!strings.Contains(hint, state.HostPID()) || !strings.Contains(hint, "port conflict") {
		t.Fatalf("stale diagnostic lacks verification and recovery steps: %s", hint)
	}
	if !host.ProcessAlive(int(record["pid"].(float64))) {
		t.Fatal("diagnosing stale identity stopped the host")
	}
	if err := os.Remove(state.HostPID()); err != nil {
		t.Fatal(err)
	}
	status, code, output = a.run("status", "--json")
	if code != 1 || errorCode(status) != contracts.CodePortInUse {
		t.Fatalf("status after stale-record removal: %d %s", code, output)
	}
	blocked, code, output := b.run("start", "--json")
	if code != 1 || errorCode(blocked) != contracts.CodePortInUse {
		t.Fatalf("start after stale-record removal: %d %s", code, output)
	}
}

func TestStartReportsHostCrash(t *testing.T) {
	inst := newInstallation(t, "-exit", "5")
	payload, code, raw := inst.run("start", "--json")
	if code != 1 || errorCode(payload) != "KB_HOST_START_FAILED" {
		t.Fatalf("start: %d %s", code, raw)
	}
}

func TestStartPrintsHumanTextWithoutJSONFlag(t *testing.T) {
	inst := newInstallation(t)
	_, code, raw := inst.run("start")
	if code != 0 || !bytes.Contains([]byte(raw), []byte("host started")) || json.Valid([]byte(raw)) {
		t.Fatalf("start: %d %q", code, raw)
	}
	_, code, raw = inst.run("start")
	if code != 1 || !bytes.Contains([]byte(raw), []byte("KB_HOST_ALREADY_RUNNING")) || !bytes.Contains([]byte(raw), []byte("Hint:")) {
		t.Fatalf("second start: %d %q", code, raw)
	}
}

func TestForegroundStartRunsTheHostDirectly(t *testing.T) {
	inst := newInstallation(t)
	command := exec.Command(inst.launcher, "start", "--foreground", "--json", "--platform-root", inst.root)
	command.Env = inst.childEnvironment()
	startTestProcessGroup(t, command)
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	finished := false
	t.Cleanup(func() {
		if finished {
			return
		}
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-waited:
		case <-time.After(15 * time.Second):
			_ = command.Process.Kill()
		}
	})
	deadline := time.Now().Add(15 * time.Second)
	for {
		if status, _, _ := inst.run("status", "--json"); status["host"] != nil && status["host"].(map[string]any)["state"] == "running" {
			break
		}
		if time.Now().After(deadline) {
			_ = command.Process.Kill()
			t.Fatal("foreground host never became healthy")
		}
		time.Sleep(50 * time.Millisecond)
	}
	rootState, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(rootState.Control()); !os.IsNotExist(err) {
		t.Fatal("foreground mode has no control channel")
	}
	_ = command.Process.Signal(syscall.SIGTERM)
	select {
	case <-waited:
		finished = true
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("launcher did not exit after SIGTERM")
	}
	if status, _, _ := inst.run("status", "--json"); status["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("host must stop with the foreground launcher: %v", status)
	}
}
