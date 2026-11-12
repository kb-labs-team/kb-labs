package manager

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/service"
)

func testServices() map[string]config.Service {
	return map[string]config.Service{
		"redis": {Name: "Redis", Type: config.ServiceTypeDocker, Port: 6379},
		"state-daemon": {
			Name: "State Daemon", Type: config.ServiceTypeNode, Port: 7777,
			DependsOn: []string{"redis"},
		},
		"workflow": {
			Name: "Workflow", Type: config.ServiceTypeNode, Port: 7778,
			DependsOn: []string{"state-daemon"},
		},
		"rest": {
			Name: "REST API", Type: config.ServiceTypeNode, Port: 5050,
			DependsOn: []string{"workflow"},
		},
		"gateway": {
			Name: "Gateway", Type: config.ServiceTypeNode, Port: 4000,
			DependsOn: []string{"state-daemon"},
		},
		"studio": {
			Name: "Studio", Type: config.ServiceTypeNode, Port: 3000,
			DependsOn: []string{"rest"},
		},
	}
}

func TestStatusReportsPortOccupantForFailedService(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	cfg := &config.Config{
		Services: map[string]config.Service{
			"gateway": {Name: "Gateway", Type: config.ServiceTypeNode, Port: port},
		},
		Settings: config.Settings{LogsDir: ".kb/logs"},
	}
	m := New(cfg, t.TempDir(), t.TempDir())
	_ = m.services["gateway"].SetState(service.StateFailed, "health check failed")

	status := m.Status().Services["gateway"]
	if status.PortOccupant == nil {
		t.Skip("lsof/netstat did not report the test listener")
	}
	if status.PortOccupant.PID <= 0 {
		t.Errorf("port occupant PID = %d, want positive PID", status.PortOccupant.PID)
	}
	if status.Cleanup != "kb-dev stop gateway --force" {
		t.Errorf("cleanup command = %q", status.Cleanup)
	}
}

func TestStartCleansProcessWhenHealthCheckFails(t *testing.T) {
	root := t.TempDir()
	cfg := &config.Config{
		Services: map[string]config.Service{
			"stuck": {
				Name:        "Stuck",
				Type:        config.ServiceTypeNode,
				Command:     "sleep 60",
				HealthCheck: "http://127.0.0.1:1/health",
			},
		},
		Settings: config.Settings{
			PIDDir:              filepath.Join(root, "pids"),
			LogsDir:             filepath.Join(root, "logs"),
			StartTimeout:        100,
			HealthCheckInterval: 10,
		},
	}
	m := New(cfg, root, root)
	m.ResolveEnv()

	result := m.Start(context.Background(), []string{"stuck"}, false)
	if result.OK {
		t.Fatal("start should fail when health check never becomes ready")
	}
	if m.services["stuck"].PID != 0 || m.services["stuck"].PGID != 0 {
		t.Fatalf("failed start retained process ownership: pid=%d pgid=%d", m.services["stuck"].PID, m.services["stuck"].PGID)
	}
	if _, err := os.Stat(filepath.Join(root, "pids", "stuck.pid")); !os.IsNotExist(err) {
		t.Fatalf("failed start PID file still exists: %v", err)
	}
}

// TestWithDependents guards the cascade-restart fix: Restart must stop AND start
// the same expanded set (targets + transitive dependents). Before the fix it
// stopped the dependents but started only the targets, leaving dependents down.
// state-daemon's transitive dependents are workflow, rest, gateway, studio.
func TestWithDependents(t *testing.T) {
	cfg := &config.Config{Services: testServices()}
	m := New(cfg, "/workspace", "/workspace")

	got := m.withDependents([]string{"state-daemon"})
	want := map[string]bool{
		"state-daemon": true, "workflow": true, "rest": true, "gateway": true, "studio": true,
	}
	if len(got) != len(want) {
		t.Fatalf("withDependents = %v, want keys %v", got, want)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected service in restart set: %q", id)
		}
	}
	// A leaf (studio) expands to just itself.
	if leaf := m.withDependents([]string{"studio"}); len(leaf) != 1 || leaf[0] != "studio" {
		t.Errorf("leaf withDependents = %v, want [studio]", leaf)
	}
}

func TestTopoLayers(t *testing.T) {
	layers, err := TopoLayers(testServices())
	if err != nil {
		t.Fatalf("TopoLayers() error: %v", err)
	}

	// Layer 0: redis (no deps)
	// Layer 1: state-daemon (depends on redis)
	// Layer 2: workflow, gateway (depend on state-daemon)
	// Layer 3: rest (depends on workflow)
	// Layer 4: studio (depends on rest)
	if len(layers) != 5 {
		t.Fatalf("got %d layers, want 5: %v", len(layers), layers)
	}

	if layers[0][0] != "redis" {
		t.Errorf("layer 0 = %v, want [redis]", layers[0])
	}
	if layers[1][0] != "state-daemon" {
		t.Errorf("layer 1 = %v, want [state-daemon]", layers[1])
	}
	// Layer 2 should have gateway and workflow (parallel).
	if len(layers[2]) != 2 {
		t.Errorf("layer 2 = %v, want 2 services", layers[2])
	}
}

func TestDepsOf(t *testing.T) {
	svcs := testServices()

	// rest depends on workflow → state-daemon → redis.
	deps := DepsOf([]string{"rest"}, svcs)
	if len(deps) != 4 {
		t.Errorf("DepsOf(rest) = %v (len %d), want 4 (rest + workflow + state-daemon + redis)", deps, len(deps))
	}

	// redis has no deps.
	deps = DepsOf([]string{"redis"}, svcs)
	if len(deps) != 1 {
		t.Errorf("DepsOf(redis) = %v, want [redis]", deps)
	}

	// Multiple targets.
	deps = DepsOf([]string{"rest", "gateway"}, svcs)
	// rest chain + gateway chain, deduplicated.
	if len(deps) != 5 {
		t.Errorf("DepsOf(rest, gateway) = %v (len %d), want 5", deps, len(deps))
	}
}

func TestBackoffDuration(t *testing.T) {
	tests := []struct {
		attempt int
		want    string
	}{
		{1, "1s"},
		{2, "2s"},
		{3, "4s"},
		{4, "8s"},
		{5, "16s"},
		{6, "30s"}, // capped at maxBackoff
		{10, "30s"},
	}
	for _, tt := range tests {
		got := backoffDuration(tt.attempt)
		if got.String() != tt.want {
			t.Errorf("backoffDuration(%d) = %s, want %s", tt.attempt, got, tt.want)
		}
	}
}

func TestContains(t *testing.T) {
	slice := []string{"a", "b", "c"}
	if !contains(slice, "b") {
		t.Error("should contain b")
	}
	if contains(slice, "d") {
		t.Error("should not contain d")
	}
}

// ── New ────────────────────────────────────────────────────────────────

func TestNew_CreatesServicesFromConfig(t *testing.T) {
	cfg := &config.Config{
		Services: testServices(),
		Settings: config.Settings{StartTimeout: 5000},
	}
	m := New(cfg, "/workspace", "/workspace")

	if len(m.services) != len(cfg.Services) {
		t.Errorf("services = %d, want %d", len(m.services), len(cfg.Services))
	}
	if m.rootDir != "/workspace" {
		t.Errorf("rootDir = %q, want /workspace", m.rootDir)
	}
	// Each service should have a lock
	if len(m.svcLocks) != len(cfg.Services) {
		t.Errorf("svcLocks = %d, want %d", len(m.svcLocks), len(cfg.Services))
	}
}

func TestNew_EmptyConfig(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/tmp", "/tmp")

	if len(m.services) != 0 {
		t.Errorf("services = %d, want 0", len(m.services))
	}
}

// ── spawnEnv ───────────────────────────────────────────────────────────

func TestSpawnEnv_MergesServiceEnv(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := config.Service{
		Env: map[string]string{
			"NODE_ENV": "production",
			"PORT":     "3000",
		},
	}
	result := m.spawnEnv(svc)

	if result["NODE_ENV"] != "production" {
		t.Errorf("NODE_ENV = %q, want production", result["NODE_ENV"])
	}
	if result["PORT"] != "3000" {
		t.Errorf("PORT = %q, want 3000", result["PORT"])
	}
	if result["KB_PROJECT_ROOT"] != "/workspace" {
		t.Errorf("KB_PROJECT_ROOT = %q, want /workspace", result["KB_PROJECT_ROOT"])
	}
}

func TestSpawnEnv_DoesNotOverrideExistingKBProjectRoot(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := config.Service{
		Env: map[string]string{"KB_PROJECT_ROOT": "/custom/root"},
	}
	result := m.spawnEnv(svc)

	if result["KB_PROJECT_ROOT"] != "/custom/root" {
		t.Errorf("KB_PROJECT_ROOT = %q, want /custom/root (should not override)", result["KB_PROJECT_ROOT"])
	}
}

func TestSpawnEnv_EmptyServiceEnv(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	result := m.spawnEnv(config.Service{})

	if result["KB_PROJECT_ROOT"] != "/workspace" {
		t.Errorf("KB_PROJECT_ROOT = %q, want /workspace", result["KB_PROJECT_ROOT"])
	}
	// The launcher declares both platform and project roots.
	if result["KB_PLATFORM_ROOT"] != "/workspace" {
		t.Errorf("KB_PLATFORM_ROOT = %q, want /workspace", result["KB_PLATFORM_ROOT"])
	}
	if len(result) != 3 {
		t.Errorf("len = %d, want 3", len(result))
	}
}

func TestSpawnEnv_InjectsKBSocketPath(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := config.Service{
		Socket: "/tmp/kb-a3f5c901/rest-api.sock",
	}
	result := m.spawnEnv(svc)

	if result["KB_SOCKET_PATH"] != "/tmp/kb-a3f5c901/rest-api.sock" {
		t.Errorf("KB_SOCKET_PATH = %q, want /tmp/kb-a3f5c901/rest-api.sock", result["KB_SOCKET_PATH"])
	}
}

func TestSpawnEnv_DoesNotOverrideExistingKBSocketPath(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := config.Service{
		Socket: "/tmp/kb-a3f5c901/rest-api.sock",
		Env:    map[string]string{"KB_SOCKET_PATH": "/custom/socket.sock"},
	}
	result := m.spawnEnv(svc)

	if result["KB_SOCKET_PATH"] != "/custom/socket.sock" {
		t.Errorf("KB_SOCKET_PATH = %q, want /custom/socket.sock (should not override)", result["KB_SOCKET_PATH"])
	}
}

// ── startTimeout ───────────────────────────────────────────────────────

func TestStartTimeout_DefaultFromConfig(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{StartTimeout: 30000},
	}
	m := New(cfg, "/workspace", "/workspace")

	got := m.startTimeout()
	want := 30 * time.Second
	if got != want {
		t.Errorf("startTimeout() = %v, want %v", got, want)
	}
}

func TestStartTimeout_ZeroConfig(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{StartTimeout: 0},
	}
	m := New(cfg, "/workspace", "/workspace")

	got := m.startTimeout()
	if got != 0 {
		t.Errorf("startTimeout() = %v, want 0", got)
	}
}

// ── Accessors ──────────────────────────────────────────────────────────

func TestAccessors(t *testing.T) {
	cfg := &config.Config{
		Services: testServices(),
		Settings: config.Settings{StartTimeout: 5000},
	}
	m := New(cfg, "/workspace", "/workspace")

	if m.Config() != cfg {
		t.Error("Config() should return the original config")
	}
	if m.RootDir() != "/workspace" {
		t.Errorf("RootDir() = %q, want /workspace", m.RootDir())
	}
}

func TestGetService_Found(t *testing.T) {
	cfg := &config.Config{
		Services: testServices(),
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := m.GetService("redis")
	if svc == nil {
		t.Fatal("GetService(redis) = nil, want non-nil")
	}
}

func TestGetService_NotFound(t *testing.T) {
	cfg := &config.Config{
		Services: testServices(),
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := m.GetService("nonexistent")
	if svc != nil {
		t.Error("GetService(nonexistent) should return nil")
	}
}

// ── computeSocketHash ─────────────────────────────────────────────────

// TestComputeSocketHash_MainWorkspace is a regression guard: ensures the hash
// for the production workspace matches the value previously hardcoded in
// devservices.yaml and kb.config.json, so socket paths don't change on upgrade.
func TestComputeSocketHash_MainWorkspace(t *testing.T) {
	got := computeSocketHash("/Users/kirillbaranov/Desktop/kb-labs-workspace")
	if got != "86a20aa2" {
		t.Errorf("computeSocketHash(main workspace) = %q, want 86a20aa2 (backward-compat value)", got)
	}
}

func TestComputeSocketHash_DifferentDirsGiveDifferentHashes(t *testing.T) {
	main := "/Users/kirillbaranov/Desktop/kb-labs-workspace"
	wt := main + "/.claude/worktrees/test-worktree"
	h1 := computeSocketHash(main)
	h2 := computeSocketHash(wt)
	if h1 == h2 {
		t.Errorf("different dirs produced same hash %q — isolation broken", h1)
	}
	if len(h1) != 8 || len(h2) != 8 {
		t.Errorf("hash lengths: %d, %d — want 8", len(h1), len(h2))
	}
}

// TestStateDir_SingleProjectMode guards backward compatibility: when rootDir
// == projectDir (today's only configuration before multi-project registries
// existed), StateDir must be byte-identical to the plain <rootDir>/<base>
// layout kb-dev has always used — no namespacing, no behavior change for
// anyone not using platform.dir-shared projects.
func TestStateDir_SingleProjectMode(t *testing.T) {
	got := StateDir("/workspace", "/workspace", ".kb/tmp")
	want := "/workspace/.kb/tmp"
	if got != want {
		t.Errorf("StateDir(rootDir==projectDir) = %q, want %q (unnamespaced)", got, want)
	}
}

func TestProcessTitleIncludesWorktreeAndStableProjectID(t *testing.T) {
	m := New(&config.Config{}, "/workspace", "/tmp/agent-a")
	title := m.processTitle("workflow", "instance-1")
	if !strings.HasPrefix(title, "kbdev:agent-a:") {
		t.Fatalf("process title = %q, want worktree label prefix", title)
	}
	if !strings.Contains(title, ":workflow:instance-1") {
		t.Fatalf("process title = %q, want service and instance", title)
	}
	if !strings.Contains(title, m.projectID) {
		t.Fatalf("process title = %q, want stable project ID %q", title, m.projectID)
	}
}

// TestStateDir_SharedPlatformNamespacesByProject guards the fix for the bug
// where two registered projects sharing one platform.dir (rootDir identical
// for both) would otherwise collapse their PID/lock/log state onto the same
// directory — project A's Reconcile/Stop would see project B's processes.
func TestStateDir_SharedPlatformNamespacesByProject(t *testing.T) {
	rootDir := "/Users/x/kb-platform"
	projectA := "/Users/x/dit-1"
	projectB := "/Users/x/dit-2"

	dirA := StateDir(rootDir, projectA, ".kb/tmp")
	dirB := StateDir(rootDir, projectB, ".kb/tmp")

	if dirA == dirB {
		t.Fatalf("two different projects sharing one platform resolved to the same state dir: %q", dirA)
	}
	unnamespaced := filepath.Join(rootDir, ".kb/tmp")
	if dirA == unnamespaced {
		t.Errorf("StateDir for a shared platform must NOT be the unnamespaced path, got %q", dirA)
	}
}

// TestStateDir_Deterministic guards that the same (rootDir, projectDir) pair
// always resolves to the same path — required for PID files written by one
// invocation to be found by the next.
func TestStateDir_Deterministic(t *testing.T) {
	a := StateDir("/platform", "/project-x", ".kb/tmp")
	b := StateDir("/platform", "/project-x", ".kb/tmp")
	if a != b {
		t.Errorf("StateDir not deterministic: %q != %q", a, b)
	}
}

func TestSpawnEnv_InjectsSocketHash(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	result := m.spawnEnv(config.Service{})

	hash, ok := result["KB_SOCKET_HASH"]
	if !ok {
		t.Fatal("KB_SOCKET_HASH not injected by spawnEnv()")
	}
	if len(hash) != 8 {
		t.Errorf("KB_SOCKET_HASH = %q, want 8-char hex string", hash)
	}
	if want := computeSocketHash("/workspace"); hash != want {
		t.Errorf("KB_SOCKET_HASH = %q, want %q (hash of projectDir)", hash, want)
	}
}

func TestSpawnEnv_DoesNotOverrideExistingSocketHash(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{},
		Settings: config.Settings{},
	}
	m := New(cfg, "/workspace", "/workspace")

	svc := config.Service{
		Env: map[string]string{"KB_SOCKET_HASH": "custom12"},
	}
	result := m.spawnEnv(svc)

	if result["KB_SOCKET_HASH"] != "custom12" {
		t.Errorf("KB_SOCKET_HASH = %q, want custom12 (should not override)", result["KB_SOCKET_HASH"])
	}
}

func TestManagerNew_ExpandsSocketHashInSocketPaths(t *testing.T) {
	projectDir := "/Users/kirillbaranov/Desktop/kb-labs-workspace"
	cfg := &config.Config{
		Services: map[string]config.Service{
			"rest": {
				Name:   "REST API",
				Type:   config.ServiceTypeNode,
				Socket: "/tmp/kb-${KB_SOCKET_HASH}/rest-api.sock",
			},
			"workflow": {
				Name:   "Workflow",
				Type:   config.ServiceTypeNode,
				Socket: "/tmp/kb-${KB_SOCKET_HASH}/workflow.sock",
			},
			"no-socket": {
				Name: "No Socket",
				Type: config.ServiceTypeNode,
			},
		},
		Settings: config.Settings{},
	}
	m := New(cfg, projectDir, projectDir)

	expectedHash := computeSocketHash(projectDir)

	rest := m.GetService("rest")
	if rest == nil {
		t.Fatal("rest service not found")
	}
	wantRest := "/tmp/kb-" + expectedHash + "/rest-api.sock"
	if rest.Config.Socket != wantRest {
		t.Errorf("rest.Config.Socket = %q, want %q", rest.Config.Socket, wantRest)
	}

	wf := m.GetService("workflow")
	if wf == nil {
		t.Fatal("workflow service not found")
	}
	wantWF := "/tmp/kb-" + expectedHash + "/workflow.sock"
	if wf.Config.Socket != wantWF {
		t.Errorf("workflow.Config.Socket = %q, want %q", wf.Config.Socket, wantWF)
	}

	// Service without a socket field is unaffected.
	ns := m.GetService("no-socket")
	if ns == nil {
		t.Fatal("no-socket service not found")
	}
	if ns.Config.Socket != "" {
		t.Errorf("no-socket.Config.Socket = %q, want empty", ns.Config.Socket)
	}
}

// ── serviceAddress ────────────────────────────────────────────────────

func TestServiceAddress_SocketService(t *testing.T) {
	addr := serviceAddress(config.Service{
		Socket: "/tmp/kb-86a20aa2/marketplace.sock",
		Port:   5070,
		URL:    "http://localhost:5070",
	})
	if addr != "unix:/tmp/kb-86a20aa2/marketplace.sock" {
		t.Errorf("serviceAddress(socket) = %q, want unix:... prefix", addr)
	}
}

func TestServiceAddress_TCPService(t *testing.T) {
	addr := serviceAddress(config.Service{
		Port: 4000,
		URL:  "http://localhost:4000",
	})
	if addr != "http://localhost:4000" {
		t.Errorf("serviceAddress(tcp) = %q, want http://localhost:4000", addr)
	}
}

func TestServiceAddress_FallbackToURL(t *testing.T) {
	addr := serviceAddress(config.Service{
		URL: "http://custom:9999",
	})
	if addr != "http://custom:9999" {
		t.Errorf("serviceAddress(fallback) = %q, want http://custom:9999", addr)
	}
}

// ── TopoLayers edge cases ──────────────────────────────────────────────

func TestTopoLayers_SingleService(t *testing.T) {
	svcs := map[string]config.Service{
		"api": {Name: "API", Type: config.ServiceTypeNode, Port: 3000},
	}
	layers, err := TopoLayers(svcs)
	if err != nil {
		t.Fatalf("TopoLayers() error: %v", err)
	}
	if len(layers) != 1 {
		t.Fatalf("got %d layers, want 1", len(layers))
	}
	if layers[0][0] != "api" {
		t.Errorf("layer 0 = %v, want [api]", layers[0])
	}
}

func TestTopoLayers_NoDeps_AllParallel(t *testing.T) {
	svcs := map[string]config.Service{
		"a": {Name: "A", Type: config.ServiceTypeNode},
		"b": {Name: "B", Type: config.ServiceTypeNode},
		"c": {Name: "C", Type: config.ServiceTypeNode},
	}
	layers, err := TopoLayers(svcs)
	if err != nil {
		t.Fatalf("TopoLayers() error: %v", err)
	}
	if len(layers) != 1 {
		t.Fatalf("got %d layers, want 1 (all independent)", len(layers))
	}
	if len(layers[0]) != 3 {
		t.Errorf("layer 0 has %d services, want 3", len(layers[0]))
	}
}
