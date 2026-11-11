// Package delivery holds the cross-module end-to-end test for the ADR-0014
// declarative delivery plane. It spins up a Verdaccio registry plus two
// SSH-reachable target containers, publishes stub packages, and runs the
// real kb-deploy binary against them.
//
// The test is opt-in: it requires Docker and takes on the order of a minute
// for the first run (image build). Run it with:
//
//	./scripts/run.sh
//
// CI gates it behind a dedicated workflow; the wrapper opts in so plain
// `go test ./...` from the repo root skips this test.
package delivery

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	target1Port = 2201
	target2Port = 2202
	verdaccio   = "http://localhost:4873"
)

// TestDelivery_EndToEnd runs the full apply → verify-on-target → rollback
// cycle against two Docker targets with a real SSH server and real pnpm.
func TestDelivery_EndToEnd(t *testing.T) {
	if os.Getenv("DELIVERY_E2E") == "" {
		t.Skip("DELIVERY_E2E not set — this test requires Docker and is opt-in.")
	}
	composeBin := requireDocker(t)

	repoRoot := findRepoRoot(t)
	deliveryDir := filepath.Join(repoRoot, "e2e", "delivery")

	// 1. Build native kb-deploy and cross-compiled kb-create for the container.
	runCmd(t, deliveryDir, "bash", "./scripts/build-binaries.sh")

	// 2. Bring up the stack (verdaccio + two target containers).
	stackDown(t, deliveryDir) // idempotent safety for prior runs
	t.Cleanup(func() { stackDown(t, deliveryDir) })
	runCmd(t, deliveryDir, composeBin[0], append(composeBin[1:], "up", "-d", "--build")...)

	waitTCP(t, "127.0.0.1:4873", 60*time.Second)
	waitTCP(t, fmt.Sprintf("127.0.0.1:%d", target1Port), 60*time.Second)
	waitTCP(t, fmt.Sprintf("127.0.0.1:%d", target2Port), 60*time.Second)

	// 3. Publish fixture packages to Verdaccio.
	runCmd(t, deliveryDir, "bash", "./scripts/publish-fixtures.sh")

	// 4. Write a deploy.yaml pointing at the two local containers.
	workdir := t.TempDir()
	deployYAML := filepath.Join(workdir, "deploy.yaml")
	keyPath := filepath.Join(deliveryDir, "keys", "id_rsa")
	writeFile(t, deployYAML, deployDoc())
	t.Setenv("KB_SSH_KEY_PATH", keyPath)

	// 5. Run kb-deploy apply.
	kbDeploy := filepath.Join(deliveryDir, "bin", "kb-deploy-host")
	out, applyErr := runCmdNoFatal(t, workdir, kbDeploy, "apply", "--config", deployYAML, "--yes")
	t.Logf("apply output:\n%s", out)
	if applyErr != nil {
		dumpContainerLogs(t, deliveryDir)
		t.Fatalf("kb-deploy apply failed: %v", applyErr)
	}

	// 6. Verify state on both targets via a direct SSH probe (independent
	// of kb-deploy to catch integration drift).
	for _, port := range []int{target1Port, target2Port} {
		client := dialSSH(t, port, keyPath)
		defer client.Close()

		releaseID := strings.TrimSpace(sshRun(t, client,
			"readlink /opt/kb-platform/services/gateway-test/current | xargs basename"))
		if !strings.HasPrefix(releaseID, "gateway-test-1.0.0-") {
			t.Fatalf("target :%d current symlink points at %q (want gateway-test-1.0.0-…)",
				port, releaseID)
		}

		relJSON := sshRun(t, client,
			"cat /opt/kb-platform/releases/"+shQuote(releaseID)+"/release.json")
		var rj struct {
			Service   string `json:"service"`
			Integrity string `json:"integrity"`
		}
		if err := json.Unmarshal([]byte(relJSON), &rj); err != nil {
			t.Fatalf("parse release.json on :%d: %v\nbody:\n%s", port, err, relJSON)
		}
		if rj.Service != "@kb-labs/gateway-test@1.0.0" {
			t.Errorf("target :%d release.json.service = %q", port, rj.Service)
		}
		if !strings.HasPrefix(rj.Integrity, "sha256-") {
			t.Errorf("target :%d integrity missing sha256 prefix: %q", port, rj.Integrity)
		}

		// node_modules/@kb-labs/gateway-test/dist/index.js must exist — this is
		// what pnpm actually installed.
		entry := sshRun(t, client,
			"test -f /opt/kb-platform/services/gateway-test/current/node_modules/@kb-labs/gateway-test/dist/index.js && echo ok")
		if strings.TrimSpace(entry) != "ok" {
			t.Errorf("target :%d dist/index.js missing after install", port)
		}

		// devservices.yaml must have been written by kb-create on swap.
		dsPath := "/opt/kb-platform/.kb/devservices.yaml"
		ds := sshRun(t, client, "cat "+dsPath)
		if !strings.Contains(ds, "gateway-test") || !strings.Contains(ds, "health_check:") {
			t.Errorf("target :%d devservices.yaml missing gateway-test entry or health_check:\n%s", port, ds)
		}

		// Real kb-dev must have brought the service up — health probe returns "ok".
		health := sshRun(t, client, "curl -fsS --max-time 5 http://localhost:4000/health")
		if strings.TrimSpace(health) != "ok" {
			t.Errorf("target :%d health probe body = %q, want \"ok\"", port, health)
		}
	}

	// 7. Verify lock was written and names both hosts.
	lockPath := filepath.Join(filepath.Dir(deployYAML), "deploy.lock.json")
	lockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("read deploy.lock.json: %v", err)
	}
	var lock struct {
		Services map[string]struct {
			AppliedTo map[string]struct {
				ReleaseID string `json:"releaseId"`
			} `json:"appliedTo"`
		} `json:"services"`
	}
	if err := json.Unmarshal(lockBytes, &lock); err != nil {
		t.Fatalf("parse lock: %v", err)
	}
	applied := lock.Services["gateway"].AppliedTo
	if len(applied) != 2 {
		t.Fatalf("lock should record both hosts, got %v", applied)
	}

	// 8. Exercise rollback via kb-create on target-1 directly — after a single
	// install there is no previous release, so rollback must exit non-zero
	// with an actionable error. This guards against silently-succeeding
	// rollback on a fresh install.
	client := dialSSH(t, target1Port, keyPath)
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	defer sess.Close()
	rbErr := sess.Run("kb-create rollback '@kb-labs/gateway-test' --platform /opt/kb-platform")
	if rbErr == nil {
		t.Error("rollback after a single install should fail — no previous release exists")
	}
}

// --- helpers ----------------------------------------------------------------

// deployDoc returns a minimal deploy.yaml referencing the two containers.
func deployDoc() string {
	return `schema: kb.deploy/1

platform:
  version: "1.0.0"
  # Seen from inside target containers via the kb-net compose network.
  registry: http://verdaccio:4873

services:
  gateway:
    service: "@kb-labs/gateway-test"
    version: "1.0.0"
    adapters:
      noop: "@kb-labs/adapter-noop@1.0.0"
    targets:
      hosts: [target-1, target-2]
      strategy: all
      healthGate: 5s

hosts:
  target-1:
    ssh:
      host: 127.0.0.1
      port: 2201
      user: kb
      key_path_env: KB_SSH_KEY_PATH
    platformPath: /opt/kb-platform
  target-2:
    ssh:
      host: 127.0.0.1
      port: 2202
      user: kb
      key_path_env: KB_SSH_KEY_PATH
    platformPath: /opt/kb-platform

rollout:
  autoRollback: true
  parallel: 2
  lockMode: artifact
`
}

func requireDocker(t *testing.T) []string {
	t.Helper()
	composeBin := deliveryCompose(t)
	out, err := exec.Command("docker", "info").CombinedOutput()
	if err != nil {
		t.Skipf("docker not running: %v\n%s", err, out)
	}
	return composeBin
}

func deliveryCompose(t *testing.T) []string {
	t.Helper()
	composeCommand := os.Getenv("KB_DELIVERY_COMPOSE_COMMAND")
	var command []string
	if composeCommand == "" || json.Unmarshal([]byte(composeCommand), &command) != nil || len(command) == 0 {
		t.Fatal("Docker Compose was not resolved; run e2e/delivery/scripts/run.sh so the shared Compose owner can select it")
	}
	return command
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Walk up until .git is seen.
	for dir := wd; dir != "/"; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
	}
	t.Fatal("could not find repo root")
	return ""
}

func runCmd(t *testing.T, cwd string, name string, args ...string) string {
	t.Helper()
	out, err := runCmdNoFatal(t, cwd, name, args...)
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, out)
	}
	return out
}

// runCmdNoFatal runs the command and returns output + error without failing
// the test, so callers can inspect logs before deciding what to do.
func runCmdNoFatal(t *testing.T, cwd string, name string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "KB_SSH_KEY_PATH="+os.Getenv("KB_SSH_KEY_PATH"))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func stackDown(t *testing.T, dir string) {
	t.Helper()
	if os.Getenv("KEEP_STACK") != "" {
		t.Log("KEEP_STACK set — leaving docker-compose stack running for debugging")
		return
	}
	compose := deliveryCompose(t)
	cmd := exec.Command(compose[0], append(compose[1:], "down", "-v", "--remove-orphans")...)
	cmd.Dir = dir
	_ = cmd.Run()
}

// dumpContainerLogs writes the stdout/stderr of target containers to the test
// log so a failing apply still leaves actionable output.
func dumpContainerLogs(t *testing.T, dir string) {
	t.Helper()
	for _, svc := range []string{"target-1", "target-2", "verdaccio"} {
		compose := deliveryCompose(t)
		cmd := exec.Command(compose[0], append(compose[1:], "logs", "--no-color", "--tail=100", svc)...)
		cmd.Dir = dir
		out, _ := cmd.CombinedOutput()
		t.Logf("=== docker-compose logs %s ===\n%s", svc, out)
	}
}

// waitTCP blocks until a dial to addr succeeds or the deadline fires.
func waitTCP(t *testing.T, addr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", addr)
}

// dialSSH connects to 127.0.0.1:<port> with the given private key file.
func dialSSH(t *testing.T, port int, keyPath string) *ssh.Client {
	t.Helper()
	pem, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("read key: %v", err)
	}
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	cfg := &ssh.ClientConfig{
		User:            "kb",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // local e2e
		Timeout:         5 * time.Second,
	}
	var lastErr error
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		client, err := ssh.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port), cfg)
		if err == nil {
			return client
		}
		lastErr = err
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("ssh dial %d: %v", port, lastErr)
	return nil
}

// sshRun executes cmd on client, returning combined output. Failure is fatal.
func sshRun(t *testing.T, client *ssh.Client, cmd string) string {
	t.Helper()
	sess, err := client.NewSession()
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	defer sess.Close()
	out, err := sess.CombinedOutput(cmd)
	if err != nil {
		t.Fatalf("ssh run %q: %v\n%s", cmd, err, out)
	}
	return string(out)
}

// shQuote is a best-effort single-quote wrapper for passing ids through bash.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// sanity check that context is used somewhere (keeps gofmt tidy).
var _ = context.Background
