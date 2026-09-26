//go:build !windows

package v2cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
)

var (
	buildOnce sync.Once
	buildDir  string
	buildErr  error
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
	return filepath.Join(buildDir, "kb-create"), filepath.Join(buildDir, "fakehost")
}

func TestMain(m *testing.M) {
	code := m.Run()
	if buildDir != "" {
		os.RemoveAll(buildDir)
	}
	os.Exit(code)
}

type installation struct {
	launcher, root, state string
	port                  int
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
	root := t.TempDir()
	spec := &contracts.HostSpec{Command: fakehost, Args: append([]string{"-port", fmt.Sprint(port)}, hostArgs...), HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: spec}
	if err := receipt.Write(root, contracts.InstallReceipt{ID: "r1", Plan: plan}); err != nil {
		t.Fatal(err)
	}
	inst := installation{launcher: launcher, root: root, state: filepath.Join(t.TempDir(), "state"), port: port}
	t.Cleanup(func() { _, _, _ = inst.run("stop", "--json") })
	return inst
}

func (i installation) run(args ...string) (map[string]any, int, string) {
	command := exec.Command(i.launcher, append(args, "--platform-root", i.root)...)
	command.Env = append(os.Environ(), "KB_CREATE_STATE_HOME="+i.state)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	}
	var parsed map[string]any
	_ = json.Unmarshal(stdout.Bytes(), &parsed)
	return parsed, code, stdout.String() + stderr.String()
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
	if code != 0 || started["ok"] != true {
		t.Fatalf("start: %d %s", code, raw)
	}
	pid := started["host"].(map[string]any)["pid"].(float64)

	info, err := os.Stat(filepath.Join(inst.state, "control.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("control.json: %v %v", info, err)
	}

	again, code, raw := inst.run("start", "--json")
	if code != 1 || errorCode(again) != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("second start: %d %s", code, raw)
	}

	status, code, raw := inst.run("status")
	host := status["host"].(map[string]any)
	if code != 0 || host["state"] != "running" || host["pid"].(float64) != pid || status["supervisor"] == nil {
		t.Fatalf("status: %d %s", code, raw)
	}

	restarted, code, raw := inst.run("restart", "--json")
	if code != 0 || restarted["ok"] != true || restarted["host"].(map[string]any)["pid"].(float64) == pid {
		t.Fatalf("restart must replace the host process: %d %s", code, raw)
	}

	stopped, code, raw := inst.run("stop", "--json")
	result, _ := stopped["stopped"].(map[string]any)
	if code != 0 || result["wasRunning"] != true || result["graceful"] != true || result["forced"] == true {
		t.Fatalf("stop: %d %s", code, raw)
	}
	if _, err := os.Stat(filepath.Join(inst.state, "control.json")); !os.IsNotExist(err) {
		t.Fatal("control.json must be gone after stop")
	}
	status, code, _ = inst.run("status")
	if code != 0 || status["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("status after stop: %v", status)
	}
	idle, code, _ := inst.run("stop", "--json")
	if code != 0 || idle["stopped"].(map[string]any)["wasRunning"] != false {
		t.Fatalf("stopping an idle host must succeed: %v", idle)
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
	if code != 1 || errorCode(payload) != "KB_HOST_PORT_IN_USE" {
		t.Fatalf("start: %d %s", code, raw)
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
	if code != 1 || !bytes.Contains([]byte(raw), []byte("KB_HOST_ALREADY_RUNNING")) || !bytes.Contains([]byte(raw), []byte("hint:")) {
		t.Fatalf("second start: %d %q", code, raw)
	}
}

func TestForegroundStartRunsTheHostDirectly(t *testing.T) {
	inst := newInstallation(t)
	command := exec.Command(inst.launcher, "start", "--foreground", "--json", "--platform-root", inst.root)
	command.Env = append(os.Environ(), "KB_CREATE_STATE_HOME="+inst.state)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if status, _, _ := inst.run("status"); status["host"] != nil && status["host"].(map[string]any)["state"] == "running" {
			break
		}
		if time.Now().After(deadline) {
			_ = command.Process.Kill()
			t.Fatal("foreground host never became healthy")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(inst.state, "control.json")); !os.IsNotExist(err) {
		t.Fatal("foreground mode has no control channel")
	}
	_ = command.Process.Signal(syscall.SIGTERM)
	select {
	case <-waited:
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("launcher did not exit after SIGTERM")
	}
	if status, _, _ := inst.run("status"); status["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("host must stop with the foreground launcher: %v", status)
	}
}
