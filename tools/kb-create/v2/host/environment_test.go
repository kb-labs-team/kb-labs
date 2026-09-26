//go:build !windows

package host

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

func TestHostReceivesPlatformSecretsAndSpecEnvironment(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "env.txt")
	f := newRunner(t, 10, 5, "-dump-env", dump)
	f.runner.Spec.Env = map[string]string{"FROM_SPEC": "spec", "SHARED": "spec-wins"}
	f.runner.SecretEnv = func() (map[string]string, error) {
		return map[string]string{"GATEWAY_JWT_SECRET": "s3cret", "SHARED": "secret"}, nil
	}
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(dump)
	if err != nil {
		t.Fatal(err)
	}
	lines := "\n" + string(data)
	for _, want := range []string{"\nGATEWAY_JWT_SECRET=s3cret\n", "\nFROM_SPEC=spec\n", "\nSHARED=spec-wins\n"} {
		if !strings.Contains(lines, want) {
			t.Fatalf("host environment lacks %q:\n%s", strings.TrimSpace(want), data)
		}
	}
}

func TestSecretEnvironmentFailureStopsTheStart(t *testing.T) {
	f := newRunner(t, 10, 5)
	f.runner.SecretEnv = func() (map[string]string, error) { return nil, errors.New("store unreadable") }
	_, err := f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	if status, _ := f.runner.Status(context.Background()); status.State != StateStopped {
		t.Fatalf("no host may run after a failed start: %+v", status)
	}
}

func TestRunToolUsesHostEnvironmentAndReturnsItsExitStatus(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "recover.sh")
	body := "#!/bin/sh\nprintf 'args=%s\\n' \"$*\"\nprintf 'secret=%s\\n' \"$GATEWAY_JWT_SECRET\"\nprintf 'cwd=%s\\n' \"$(pwd -P)\"\nread line\nprintf 'stdin=%s\\n' \"$line\"\nexit 3\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	f := newRunner(t, 10, 5)
	f.runner.Spec.WorkingDir = root
	f.runner.SecretEnv = func() (map[string]string, error) { return map[string]string{"GATEWAY_JWT_SECRET": "s3cret"}, nil }
	var out bytes.Buffer
	code, err := f.runner.RunTool(context.Background(), Tool{Command: script, Args: []string{"--base"}}, []string{"--email", "a@b.c"}, strings.NewReader("hunter2\n"), &out, &out)
	if err != nil || code != 3 {
		t.Fatalf("code %d, err %v\n%s", code, err, out.String())
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	for _, want := range []string{"args=--base --email a@b.c", "secret=s3cret", "cwd=" + resolvedRoot, "stdin=hunter2"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("tool output lacks %q:\n%s", want, out.String())
		}
	}
	if _, err := f.runner.RunTool(context.Background(), Tool{Command: filepath.Join(root, "missing")}, nil, nil, &out, &out); err == nil {
		t.Fatal("a tool that cannot be started is an error, not an exit status")
	}
}

func TestProberStartsTheDeclaredHostOnceAndLeavesNothingRunning(t *testing.T) {
	port := freePort(t)
	state := State{Dir: filepath.Join(t.TempDir(), "launcher")}
	prober := Prober{PlatformRoot: t.TempDir(), State: state}
	declared := contracts.HostSpec{Command: fakeHostBinary, Args: []string{"-port", fmt.Sprint(port)}, HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	if err := prober.Probe(context.Background(), declared); err != nil {
		t.Fatal(err)
	}
	if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Fatal("the probed host must be stopped again")
	}
	for _, path := range []string{state.HostPID(), state.SupervisorPID(), state.Control()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("a probe must not touch the real host's state: %s", path)
		}
	}
}

func TestProberReportsAHostThatDoesNotStart(t *testing.T) {
	port := freePort(t)
	prober := Prober{PlatformRoot: t.TempDir(), State: State{Dir: t.TempDir()}}
	declared := contracts.HostSpec{Command: fakeHostBinary, Args: []string{"-port", fmt.Sprint(port), "-exit", "5"}, HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10}
	if code := launcherCode(t, prober.Probe(context.Background(), declared)); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	invalid := contracts.HostSpec{Command: "host", HealthURL: "http://example.com:1/health"}
	if code := launcherCode(t, prober.Probe(context.Background(), invalid)); code != "KB_HOST_SPEC_INVALID" {
		t.Fatalf("code %s", code)
	}
}
