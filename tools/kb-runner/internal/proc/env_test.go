//go:build darwin || linux

package proc

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func TestCleanEnvironmentUsesOnlyConfiguredEntries(t *testing.T) {
	configured := []string{"HOME=/tmp/runner-home", "PATH=/usr/bin", "TERM=xterm-256color"}
	parent := []string{"CLAUDECODE=parent", "CLAUDE_CODE_MESSAGING_TOKEN=parent-secret", "PATH=/usr/local/bin", "NPM_CONFIG_TOKEN=private", keeperDispatchEnv + "=" + keeperDispatchValue}
	got := environmentFor(Config{Env: configured, CleanEnv: true}, parent)
	if !reflect.DeepEqual(got, configured) {
		t.Fatalf("clean child environment=%q want=%q", got, configured)
	}
}

func TestKeeperDispatchMarkerNeverReachesSupervisedEnvironment(t *testing.T) {
	configured := []string{"PATH=/usr/bin", keeperDispatchEnv + "=" + keeperDispatchValue}
	for _, cfg := range []Config{
		{Env: configured},
		{Env: configured, CleanEnv: true},
	} {
		got := environmentFor(cfg, []string{"PATH=/bin", keeperDispatchEnv + "=" + keeperDispatchValue})
		for _, entry := range got {
			if strings.HasPrefix(entry, keeperDispatchEnv+"=") {
				t.Fatalf("keeper dispatch marker leaked into supervised environment: %q", got)
			}
		}
	}
}

// case: S-237.146
func TestConfigureCommandHonorsExplicitCommandTempDir(t *testing.T) {
	stateDir := t.TempDir()
	runScratch := t.TempDir()
	commandTempDir := t.TempDir()
	config := Config{CommandTempDir: commandTempDir}
	command := exec.Command("/bin/true")
	if err := configureCommand(command, config, "tempdir-run", stateDir, runScratch); err != nil {
		t.Fatalf("configure command environment: %v", err)
	}
	environment := make(map[string]string)
	for _, item := range command.Env {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			environment[key] = value
		}
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		if environment[name] != commandTempDir {
			t.Fatalf("%s = %q, want configured command temp dir %q", name, environment[name], commandTempDir)
		}
	}
	if environment["KB_RUNNER_SCRATCH"] != runScratch {
		t.Fatalf("KB_RUNNER_SCRATCH = %q, want proc run scratch %q", environment["KB_RUNNER_SCRATCH"], runScratch)
	}
}

// A resource grant must not erase the run identity: the runner proves worker
// liveness through KBLABS_CLIPROC_RUN, so a granted child without it is
// reported as unknown and blocks every later admission.
func TestConfigureCommandKeepsRunIdentityWithResourceGrant(t *testing.T) {
	stateDir := t.TempDir()
	runScratch := t.TempDir()
	command := exec.Command("/bin/true")
	command.Env = []string{"PATH=/usr/bin", runEnv + "=stale-parent-run", "KB_RUNNER_CPUS=99"}
	config := Config{GrantedCPUs: 2, MemoryBytes: 1 << 30}
	if err := configureCommand(command, config, "granted-run", stateDir, runScratch); err != nil {
		t.Fatalf("configure command environment: %v", err)
	}
	counts := make(map[string]int)
	environment := make(map[string]string)
	for _, item := range command.Env {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			counts[key]++
			environment[key] = value
		}
	}
	want := map[string]string{runEnv: "granted-run", resourceStateEnv: stateDir, "KB_RUNNER_CPUS": "2", "KB_RUNNER_MEM_BYTES": "1073741824"}
	for key, value := range want {
		if environment[key] != value || counts[key] != 1 {
			t.Fatalf("%s = %q (count %d), want exactly one %q; env=%q", key, environment[key], counts[key], value, command.Env)
		}
	}
}
