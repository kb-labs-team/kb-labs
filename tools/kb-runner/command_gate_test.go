package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// case: S-237.69
func TestCommandPolicyClassifiesLightAndHeavyExact(t *testing.T) {
	cases := []struct {
		tool string
		args []string
		want bool
	}{
		{tool: "go", args: []string{"version"}},
		{tool: "go", args: []string{"env", "GOPATH"}},
		{tool: "go", args: []string{"test", "./..."}, want: true},
		{tool: "go", args: []string{"build", "./..."}, want: true},
		{tool: "pnpm", args: []string{"--version"}},
		{tool: "pnpm", args: []string{"build"}, want: true},
		{tool: "pnpm", args: []string{"run", "type-check"}, want: true},
		{tool: "kb-devkit", args: []string{"version"}},
		{tool: "kb-devkit", args: []string{"run", "build"}, want: true},
		{tool: "tsc", args: []string{"--help"}},
		{tool: "tsc", args: []string{"--build"}, want: true},
		{tool: "vitest", args: []string{"--version"}},
		{tool: "vitest", args: []string{"run"}, want: true},
		{tool: "git", args: []string{"status"}},
	}
	for _, test := range cases {
		t.Run(test.tool+" "+test.args[0], func(t *testing.T) {
			got, err := commandNeedsTokens(test.tool, test.args)
			if err != nil || got != test.want {
				t.Fatalf("commandNeedsTokens(%q, %q) = %t, %v; want %t", test.tool, test.args, got, err, test.want)
			}
		})
	}
}

// case: S-237.69
func TestPrepareTokenCommandCapsGoAndVitestFanout(t *testing.T) {
	goArgs, goEnv, err := prepareTokenCommand("go", []string{"test", "-p", "12", "./..."}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"test", "-p=1", "./..."}; !reflect.DeepEqual(goArgs, want) {
		t.Fatalf("go args = %q, want %q", goArgs, want)
	}
	if want := []string{"GOMAXPROCS=1", "npm_config_workspace_concurrency=1", "TURBO_CONCURRENCY=1", "VITEST_MAX_FORKS=1"}; !reflect.DeepEqual(goEnv, want) {
		t.Fatalf("go environment = %q, want %q", goEnv, want)
	}

	vitestArgs, _, err := prepareTokenCommand("vitest", []string{"run", "--maxWorkers=12"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"run", "--maxWorkers=1"}; !reflect.DeepEqual(vitestArgs, want) {
		t.Fatalf("vitest args = %q, want %q", vitestArgs, want)
	}

	_, pnpmEnv, err := prepareTokenCommand("pnpm", []string{"build"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"GOMAXPROCS=1", "npm_config_workspace_concurrency=1", "TURBO_CONCURRENCY=1", "VITEST_MAX_FORKS=1"}; !reflect.DeepEqual(pnpmEnv, want) {
		t.Fatalf("pnpm environment = %q, want %q", pnpmEnv, want)
	}
}

// case: S-237.69
func TestInstalledAgentShimCallsSharedGateForLightCommand(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	jobID := "shim-test"
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(root, "runner-args")
	runner := filepath.Join(root, "fake-kb-runner")
	if err := os.WriteFile(runner, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	realGo := filepath.Join(binDir, "go")
	if err := os.WriteFile(realGo, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	shimDir, err := installCommandShims(state, jobID, runner)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(filepath.Join(shimDir, "go"), "version")
	command.Env = append(os.Environ(), "CAPTURE="+capture, "PATH="+shimDir+string(os.PathListSeparator)+binDir)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run installed go shim: %v\n%s", err, output)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"gate", "command", "--tool", "go", "--real", realGo, "--state", state, "--shim-dir", shimDir, "--", "version"}
	if got := strings.Split(strings.TrimSpace(string(data)), "\n"); !reflect.DeepEqual(got, want) {
		t.Fatalf("shim runner arguments = %q, want %q", got, want)
	}
}

// case: S-237.69
func TestNestedVitestShimReusesHeldTokenAndAppliesGrant(t *testing.T) {
	root := t.TempDir()
	capture := filepath.Join(root, "command-result")
	realVitest := filepath.Join(root, "vitest")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\nprintf '%s\\n' \"$GOMAXPROCS:$VITEST_MAX_FORKS\" >> \"$CAPTURE\"\n"
	if err := os.WriteFile(realVitest, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAPTURE", capture)
	t.Setenv("KBLABS_COMMAND_TOKEN_ACTIVE", "1")
	t.Setenv("KBLABS_COMMAND_TOKEN_GRANT", "1")
	grantDir := filepath.Join(root, "grant")
	t.Setenv("KBLABS_COMMAND_TOKEN_GRANT_DIR", grantDir)
	state := filepath.Join(root, "state")
	shimDir := filepath.Join(root, "shim")
	var stdout, stderr strings.Builder
	code, err := gateCommandExec(runnerRoot{invocation: "kb-runner"}, []string{
		"command", "--tool", "vitest", "--real", realVitest, "--state", state, "--shim-dir", shimDir, "--", "run", "--maxWorkers=8",
	}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("nested token command status=%d err=%v stderr=%q", code, err, stderr.String())
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "run\n--maxWorkers=1\n1:1\n"; got != want {
		t.Fatalf("nested vitest command result = %q, want %q", got, want)
	}
	queue, err := readNestedGrantQueueState(grantDir)
	if err != nil || queue.NextTicket != 1 || len(queue.Active) != 0 || len(queue.Waiting) != 0 {
		t.Fatalf("nested command queue after completion = %+v, err=%v; want one released grant", queue, err)
	}
}

// case: S-237.69
func TestNestedHeavyCommandsShareEachOuterGrantLocalQueue(t *testing.T) {
	var active, maximum atomic.Int64
	var completed atomic.Int64
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	var all sync.WaitGroup
	grantDirs := make([]string, 0, 6)
	for outer := range 6 {
		grantDirs = append(grantDirs, filepath.Join(t.TempDir(), fmt.Sprintf("grant-%d", outer)))
	}
	t.Cleanup(func() {
		releaseAll()
		all.Wait()
	})
	for outer, grantDir := range grantDirs {
		for nested := range 3 {
			all.Add(1)
			go func() {
				defer all.Done()
				_, err := runUnderLocalGrant(grantDir, 1, func() (int, error) {
					current := active.Add(1)
					for observed := maximum.Load(); current > observed; observed = maximum.Load() {
						if maximum.CompareAndSwap(observed, current) {
							break
						}
					}
					<-release
					active.Add(-1)
					completed.Add(1)
					return 0, nil
				})
				if err != nil {
					t.Errorf("outer=%d nested=%d: %v", outer, nested, err)
				}
			}()
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		activeRequests, waitingRequests := 0, 0
		for _, grantDir := range grantDirs {
			state, err := readNestedGrantQueueState(grantDir)
			if err != nil {
				t.Fatalf("read local grant queue state: %v", err)
			}
			activeRequests += len(state.Active)
			waitingRequests += len(state.Waiting)
		}
		if activeRequests+waitingRequests == 18 {
			if activeRequests > 6 || maximum.Load() > 6 {
				t.Fatalf("six outer grants over-admitted: active=%d waiting=%d peak=%d", activeRequests, waitingRequests, maximum.Load())
			}
			if activeRequests == 6 && waitingRequests == 12 && maximum.Load() == 6 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("nested requests did not join all six local queues: active=%d waiting=%d", activeRequests, waitingRequests)
		}
		runtime.Gosched()
	}
	releaseAll()
	all.Wait()
	if got := maximum.Load(); got != 6 {
		t.Fatalf("simultaneous nested heavy command trees = %d; want six outer grants", got)
	}
	if got := completed.Load(); got != 18 {
		t.Fatalf("nested commands completed = %d; want all 18", got)
	}
}

// case: S-237.69
func TestNestedHeavyShimJoinsLocalGrantInsteadOfBypassing(t *testing.T) {
	root := t.TempDir()
	capture := filepath.Join(root, "command-result")
	realGo := filepath.Join(root, "go")
	if err := os.WriteFile(realGo, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$CAPTURE\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAPTURE", capture)
	t.Setenv("KBLABS_COMMAND_TOKEN_ACTIVE", "1")
	t.Setenv("KBLABS_COMMAND_TOKEN_GRANT", "1")
	grantDir := filepath.Join(root, "grant")
	t.Setenv("KBLABS_COMMAND_TOKEN_GRANT_DIR", grantDir)
	var stdout, stderr strings.Builder
	code, err := gateCommandExec(runnerRoot{invocation: "kb-runner"}, []string{
		"command", "--tool", "go", "--real", realGo, "--state", filepath.Join(root, "state"), "--shim-dir", filepath.Join(root, "shim"), "--", "test", "./...",
	}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("nested heavy command status=%d err=%v stderr=%q", code, err, stderr.String())
	}
	queue, err := readNestedGrantQueueState(grantDir)
	if err != nil || queue.NextTicket != 1 || len(queue.Active) != 0 || len(queue.Waiting) != 0 {
		t.Fatalf("nested command queue after completion = %+v, err=%v; want one released grant", queue, err)
	}
	data, err := os.ReadFile(capture)
	if err != nil || strings.TrimSpace(string(data)) != "test -p=1 ./..." {
		t.Fatalf("nested command capture=%q err=%v", data, err)
	}
}
