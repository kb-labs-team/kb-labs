package v2cli

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/supervisor"
)

// case: S-261.7
func TestTestHostCleanupRunsAfterFailure(t *testing.T) {
	if os.Getenv("KB_CREATE_TEST_FAILURE_CLEANUP") == "1" {
		port, err := strconv.Atoi(os.Getenv("KB_CREATE_TEST_FAILURE_PORT"))
		if err != nil {
			t.Fatalf("read failure harness host port: %v", err)
		}
		inst := newInstallationWithRoot(t, os.Getenv("KB_CREATE_TEST_FAILURE_LAUNCHER"),
			os.Getenv("KB_CREATE_TEST_FAILURE_FAKEHOST"), os.Getenv("KB_CREATE_TEST_FAILURE_ROOT"),
			os.Getenv("KB_CREATE_TEST_FAILURE_HOME"), port)
		if _, code, output := inst.run("start", "--json"); code != 0 {
			t.Fatalf("start test supervisor: code=%d output=%s", code, output)
		}
		t.Fatal("intentional failure after supervisor start")
	}

	launcher, fakehost := binaries(t)
	root := filepath.Join(t.TempDir(), "install")
	kbHome := t.TempDir()
	port := freeLoopbackPortWithOffset(t, 0)
	registerTestHostProcessTreeCleanup(t, root)
	inst := installation{launcher: launcher, root: root, kbHome: kbHome, t: t}
	t.Cleanup(func() {
		if _, code, output := inst.run("stop", "--json"); code != 0 {
			t.Errorf("failure harness fallback stop: code=%d output=%s", code, output)
		}
	})
	command := exec.Command(os.Args[0], "-test.run=^TestTestHostCleanupRunsAfterFailure$")
	command.Env = inst.childEnvironment("KB_CREATE_TEST_FAILURE_CLEANUP=1",
		"KB_CREATE_TEST_FAILURE_ROOT="+root, "KB_CREATE_TEST_FAILURE_HOME="+kbHome,
		"KB_CREATE_TEST_FAILURE_LAUNCHER="+launcher, "KB_CREATE_TEST_FAILURE_FAKEHOST="+fakehost,
		"KB_CREATE_TEST_FAILURE_PORT="+strconv.Itoa(port))
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "intentional failure after supervisor start") {
		t.Fatalf("failure harness result = %v, output=%s; want its deliberate test failure", err, output)
	}
	if strings.Contains(string(output), "test process remains alive") || strings.Contains(string(output), "could not audit test process") {
		t.Fatalf("failure cleanup left a child process or failed its process audit: %s", output)
	}
	state, err := host.StateForRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if record, alive := host.ActiveHost(state); alive {
		t.Fatalf("failure cleanup left host pid %d alive", record.PID)
	}
	if record, alive := supervisor.ReadRecord(state); alive {
		t.Fatalf("failure cleanup left supervisor pid %d alive", record.PID)
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("failure cleanup left host port %d bound: %v", port, err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
}
