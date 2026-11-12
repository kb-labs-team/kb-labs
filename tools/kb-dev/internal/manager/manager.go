package manager

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/docker"
	"github.com/kb-labs/dev/internal/environ"
	"github.com/kb-labs/dev/internal/health"
	"github.com/kb-labs/dev/internal/logger"
	"github.com/kb-labs/dev/internal/process"
	"github.com/kb-labs/dev/internal/service"
)

// computeSocketHash returns the first 8 hex characters of MD5(dir).
// Used to derive a project-unique socket directory: /tmp/kb-<hash>/<service>.sock.
// Matches the convention documented in config.Service.Socket.
func computeSocketHash(dir string) string {
	h := md5.Sum([]byte(dir))
	return hex.EncodeToString(h[:])[:8]
}

// serviceAddress returns the human-readable address for a service.
// Socket-based services show "unix:<path>"; TCP services show "http://localhost:<port>"
// or fall back to the configured URL.
func serviceAddress(cfg config.Service) string {
	if cfg.Socket != "" {
		return "unix:" + cfg.Socket
	}
	if cfg.Port > 0 {
		return fmt.Sprintf("http://localhost:%d", cfg.Port)
	}
	return cfg.URL
}

const (
	defaultGracePeriod = 5 * time.Second
	slowThreshold      = 2 * time.Second
	logTailLines       = 5
)

// Manager orchestrates service lifecycle operations.
type Manager struct {
	cfg        *config.Config
	services   map[string]*service.Service
	rootDir    string
	projectDir string
	projectID  string
	configPath string
	envCache   *environ.EnvCache
	events     chan Event

	// Per-service locks prevent concurrent start/stop of the same service.
	// Without this, "ensure rest gateway" can try to start redis twice
	// because both rest and gateway depend on it and resolve deps in parallel.
	svcLocks map[string]*sync.Mutex

	// netOffset is the KB_NET_OFFSET applied to this run; passed to spawned
	// services so they bind the same shifted ports kb-dev probes.
	netOffset int
}

// SetNetOffset records the virtual-network port offset for spawnEnv passthrough.
func (m *Manager) SetNetOffset(offset int) { m.netOffset = offset }

// SetConfigPath records the exact service definition used for this instance.
// It lets fleet inspection recover runtimes started with an explicit config
// such as .kb/devservices.dev.yaml after the worktree is no longer cwd.
func (m *Manager) SetConfigPath(path string) { m.configPath = path }

// StateDir returns the effective directory for a state category (PIDDir,
// LogsDir, …) given a rootDir/projectDir pair.
//
// When rootDir == projectDir (single-project mode — one devservices.yaml per
// project, today's only configuration before multi-project registries
// existed) it's <rootDir>/<base>, byte-identical to the original layout.
//
// When they differ — a platform shared across several registered projects
// via platform.dir — every project resolves to the *same* rootDir, which
// would otherwise collapse their PID files, lock, logs, and net-offset cache
// onto one shared directory (project A's Reconcile/Stop would see project
// B's processes and vice versa). Namespacing by the project's socket-hash
// (the same hash already used for KB_SOCKET_HASH) keeps them isolated.
func StateDir(rootDir, projectDir, base string) string {
	if filepath.Clean(rootDir) == filepath.Clean(projectDir) {
		return filepath.Join(rootDir, base)
	}
	return filepath.Join(rootDir, base, computeSocketHash(projectDir))
}

// stateDir is the instance-bound convenience wrapper around StateDir.
func (m *Manager) stateDir(base string) string {
	return StateDir(m.rootDir, m.projectDir, base)
}

func (m *Manager) processTitle(service, instanceID string) string {
	label := filepath.Base(filepath.Clean(m.projectDir))
	if label == "." || label == string(filepath.Separator) || label == "" {
		label = m.projectID
	}
	label = strings.NewReplacer(" ", "_", ":", "_", "'", "_").Replace(label)
	return fmt.Sprintf("kbdev:%s:%s:%s:%s", label, m.projectID, service, instanceID)
}

// New creates a Manager from a parsed config.
// rootDir is the platform/config directory (where devservices.yaml lives).
// projectDir is the user's project directory (injected as KB_PROJECT_ROOT).
func New(cfg *config.Config, rootDir, projectDir string) *Manager {
	m := &Manager{
		cfg:        cfg,
		services:   make(map[string]*service.Service),
		rootDir:    rootDir,
		projectDir: projectDir,
		projectID:  computeSocketHash(projectDir),
		events:     make(chan Event, 100),
		svcLocks:   make(map[string]*sync.Mutex),
	}

	for id, svcCfg := range cfg.Services {
		m.services[id] = service.New(id, svcCfg)
		m.svcLocks[id] = &sync.Mutex{}
	}

	// Expand ${KB_SOCKET_HASH} placeholders in socket paths so that spawnEnv()
	// and health probes always receive the fully-resolved path.
	hash := computeSocketHash(projectDir)
	for _, svc := range m.services {
		if strings.Contains(svc.Config.Socket, "${KB_SOCKET_HASH}") {
			svc.Config.Socket = strings.ReplaceAll(svc.Config.Socket, "${KB_SOCKET_HASH}", hash)
		}
	}

	return m
}

// spawnEnv returns the env map to pass to a spawned service, merging the
// service's own Env with KB Labs conventional variables (KB_PROJECT_ROOT,
// KB_SOCKET_PATH) so that services can locate the user's .kb/kb.config.json
// and bind to the correct unix socket when configured.
func (m *Manager) spawnEnv(svcCfg config.Service) map[string]string {
	merged := m.spawnEnvFor(svcCfg, "", "")
	// Keep the historical helper contract for callers/tests that use it to
	// inspect only the platform injection. Managed spawns use spawnEnvFor.
	delete(merged, "KB_DEV_PROJECT_ID")
	delete(merged, "KB_DEV_PROJECT_ROOT")
	delete(merged, "KB_DEV_SERVICE")
	delete(merged, "KB_DEV_INSTANCE")
	return merged
}

// spawnEnvFor adds ownership metadata to every managed process. The metadata
// is the cross-worktree identity used by fleet inspection; process titles and
// command lines are only human-facing diagnostics.
func (m *Manager) spawnEnvFor(svcCfg config.Service, serviceID, instanceID string) map[string]string {
	svcEnv := svcCfg.Env
	merged := make(map[string]string, len(svcEnv)+8)
	for k, v := range svcEnv {
		merged[k] = v
	}
	merged["KB_PLATFORM_ROOT"] = m.rootDir
	// Do not overwrite if already set — the service or the launching shell
	// may have a good reason to pin it to a different value.
	if _, ok := merged["KB_PROJECT_ROOT"]; !ok {
		merged["KB_PROJECT_ROOT"] = m.projectDir
	}
	// KB_SOCKET_HASH lets services and their platform config (kb.config.json) derive
	// their socket directory via ${KB_SOCKET_HASH} interpolation at bootstrap time.
	if _, ok := merged["KB_SOCKET_HASH"]; !ok {
		merged["KB_SOCKET_HASH"] = computeSocketHash(m.projectDir)
	}
	if svcCfg.Socket != "" {
		if _, ok := merged["KB_SOCKET_PATH"]; !ok {
			merged["KB_SOCKET_PATH"] = svcCfg.Socket
		}
	}
	// Pass the virtual-network offset so the service (transport adapter / edge
	// bootstrap) binds the same shifted port kb-dev probes. Don't overwrite an
	// explicit value.
	if m.netOffset != 0 {
		if _, ok := merged["KB_NET_OFFSET"]; !ok {
			merged["KB_NET_OFFSET"] = strconv.Itoa(m.netOffset)
		}
	}
	if _, ok := merged["KB_DEV_PROJECT_ID"]; !ok {
		merged["KB_DEV_PROJECT_ID"] = m.projectID
	}
	if _, ok := merged["KB_DEV_PROJECT_ROOT"]; !ok {
		merged["KB_DEV_PROJECT_ROOT"] = m.projectDir
	}
	if serviceID != "" {
		if _, ok := merged["KB_DEV_SERVICE"]; !ok {
			merged["KB_DEV_SERVICE"] = serviceID
		}
	}
	if instanceID != "" {
		if _, ok := merged["KB_DEV_INSTANCE"]; !ok {
			merged["KB_DEV_INSTANCE"] = instanceID
		}
	}
	return merged
}

// Reconcile checks PID files against running processes and updates service states.
func (m *Manager) Reconcile() error {
	pidDir := m.stateDir(m.cfg.Settings.PIDDir)
	alive, err := process.Reconcile(pidDir)
	if err != nil {
		return fmt.Errorf("reconcile PIDs: %w", err)
	}

	for id, svc := range m.services {
		info, ok := alive[id]
		if !ok {
			continue
		}

		svc.PID = info.PID
		svc.PGID = info.PGID
		svc.StartedAt = info.StartedAt
		// A manager reconstructed for a project (for example by `switch` or
		// fleet cleanup) may not have the original offset on its command line.
		// Recover it from the owned PID record before Docker stop/status actions
		// derive the container name; otherwise an offset container could leak.
		if m.netOffset == 0 && info.NetOffset != 0 {
			m.netOffset = info.NetOffset
		}

		// Check health to determine if alive or degraded.
		if svc.Config.HealthCheck != "" {
			probe := health.ClassifyServiceProbe(svc.Config.HealthCheck, svc.Config.Socket, 3*time.Second)
			result := probe.Execute(context.Background())
			if result.OK {
				_ = svc.SetState(service.StateStarting, "")
				_ = svc.SetState(service.StateAlive, "")
				svc.LastLatency = result.Latency
			} else {
				_ = svc.SetState(service.StateStarting, "")
				_ = svc.SetState(service.StateFailed, "process running but health check fails")
			}
		} else {
			// No health check — if PID is alive, assume alive.
			_ = svc.SetState(service.StateStarting, "")
			_ = svc.SetState(service.StateAlive, "")
		}
	}

	return nil
}

// ResolveEnv loads or creates the environment cache.
func (m *Manager) ResolveEnv() {
	cachePath := filepath.Join(m.stateDir(m.cfg.Settings.PIDDir), "env-cache.json")

	cache, _ := environ.LoadCache(cachePath)
	if cache != nil && !cache.IsStale() {
		m.envCache = cache
		return
	}

	cache = environ.Resolve()
	_ = cache.Save(cachePath)
	m.envCache = cache
}

// ValidateRuntime verifies the Node binary injected into managed services.
func (m *Manager) ValidateRuntime() error {
	if m.envCache == nil {
		m.ResolveEnv()
	}
	return m.envCache.ValidateNode()
}

// UseNode activates and persists a supported Node binary for this project.
func (m *Manager) UseNode(nodePath string) error {
	if err := sharedtoolchain.ActivateNode(nodePath); err != nil {
		return err
	}
	if m.envCache == nil {
		m.ResolveEnv()
	}
	m.envCache.Node = nodePath
	binDir := filepath.Dir(nodePath)
	m.envCache.ExtraPath = append([]string{binDir}, withoutPath(m.envCache.ExtraPath, binDir)...)
	return m.envCache.Save(filepath.Join(m.stateDir(m.cfg.Settings.PIDDir), "env-cache.json"))
}

func withoutPath(paths []string, unwanted string) []string {
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		if path != unwanted {
			result = append(result, path)
		}
	}
	return result
}

// GroupMembers returns the service IDs belonging to the named devservices
// group, or nil when no such group exists. Used by scenario apply to bring
// a domain online before restarting its services.
func (m *Manager) GroupMembers(name string) []string {
	if services, ok := m.cfg.Groups[name]; ok {
		return append([]string(nil), services...)
	}
	return nil
}

// withLock acquires a cross-process file lock for mutation operations.
// Prevents two concurrent kb-dev instances from starting/stopping the same services.
func (m *Manager) withLock(fn func() *Result) *Result {
	lock, err := process.AcquireLock(m.stateDir(m.cfg.Settings.PIDDir))
	if err != nil {
		return &Result{
			OK:      false,
			Actions: []Action{{Action: "failed", Error: err.Error()}},
			Hint:    "another kb-dev instance is running. Wait for it to finish or kill it: pkill -f kb-dev",
		}
	}
	defer lock.Release()

	// Re-reconcile under lock — state may have changed while waiting.
	_ = m.Reconcile()

	return fn()
}

// Start starts the specified services with dependency resolution.
// Acquires a cross-process file lock to prevent duplicate starts from concurrent kb-dev instances.
func (m *Manager) Start(ctx context.Context, targets []string, force bool) *Result {
	return m.withLock(func() *Result {
		return m.startInternal(ctx, targets, force)
	})
}

func (m *Manager) startInternal(ctx context.Context, targets []string, force bool) *Result {
	allNeeded := DepsOf(targets, m.cfg.Services)
	layers, _ := TopoLayers(m.cfg.Services)

	var allActions []Action
	failed := false

	for _, layer := range layers {
		var layerTargets []string
		for _, id := range layer {
			if contains(allNeeded, id) {
				layerTargets = append(layerTargets, id)
			}
		}
		if len(layerTargets) == 0 {
			continue
		}

		actions := m.startLayer(ctx, layerTargets, force)
		allActions = append(allActions, actions...)
		for _, a := range actions {
			if a.Action == "failed" {
				failed = true
			}
		}
		if failed {
			break
		}
	}

	result := &Result{OK: !failed, Actions: allActions}
	if failed {
		result.Hint = "some services failed to start. Check logs: kb-dev logs <service>"
	}
	return result
}

func (m *Manager) startLayer(ctx context.Context, targets []string, force bool) []Action {
	var (
		mu      sync.Mutex
		actions []Action
		wg      sync.WaitGroup
	)

	for _, id := range targets {
		id := id
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := m.startOne(ctx, id, force)
			mu.Lock()
			actions = append(actions, a)
			mu.Unlock()
		}()
	}

	wg.Wait()
	return actions
}

func (m *Manager) startOne(ctx context.Context, id string, force bool) Action {
	// Per-service lock prevents duplicate starts when multiple dependents
	// resolve the same dependency in parallel.
	m.svcLocks[id].Lock()
	defer m.svcLocks[id].Unlock()

	svc := m.services[id]
	state := svc.GetState()

	// Already alive — skip (re-check under lock).
	if state == service.StateAlive {
		return Action{Service: id, Action: "skipped", Reason: "already alive"}
	}

	// Port conflict handling.
	if svc.Config.Port > 0 {
		if force {
			// Force mode: kill whatever is on the port and proceed.
			_ = process.KillPort(svc.Config.Port)
			time.Sleep(300 * time.Millisecond)
		} else if isPortOccupied(svc.Config.Port) {
			// Non-force mode: if the port is already taken, refuse to start.
			// This prevents a misleading "started" when the port belongs to another process.
			return Action{
				Service: id,
				Action:  "failed",
				Error:   fmt.Sprintf("port %d is already in use — use --force to kill it first", svc.Config.Port),
			}
		}
	}

	// Docker services.
	if svc.Config.Type == config.ServiceTypeDocker {
		return m.startDocker(ctx, svc)
	}

	// Node services.
	return m.startNode(ctx, svc)
}

func (m *Manager) startDocker(ctx context.Context, svc *service.Service) Action {
	start := time.Now()

	if err := docker.EnsureRunning(ctx); err != nil {
		return Action{Service: svc.ID, Action: "failed", Error: "Docker unavailable: " + err.Error()}
	}

	_ = svc.SetState(service.StateStarting, "")

	logsDir := m.stateDir(m.cfg.Settings.LogsDir)
	_ = logger.EnsureDir(logsDir)
	_ = logger.Clear(logsDir, svc.ID)

	// Run docker command via spawn.
	instanceID := process.NewInstanceID()
	spawnResult, err := process.Spawn(process.SpawnOpts{
		Command:  svc.Config.Command,
		Title:    m.processTitle(svc.ID, instanceID),
		Env:      m.spawnEnvFor(svc.Config, svc.ID, instanceID),
		Dir:      m.rootDir,
		LogFile:  logger.LogPath(logsDir, svc.ID),
		EnvCache: m.envCache,
	})
	if err != nil {
		_ = svc.SetState(service.StateFailed, err.Error())
		return Action{Service: svc.ID, Action: "failed", Error: err.Error()}
	}

	svc.PID = spawnResult.PID
	svc.PGID = spawnResult.PGID
	svc.StartedAt = start

	pidDir := m.stateDir(m.cfg.Settings.PIDDir)
	pidInfo := process.NewPIDInfo(svc.ID, spawnResult.PID, spawnResult.PGID, svc.Config.Command)
	pidInfo.ProjectID = m.projectID
	pidInfo.ProjectRoot = m.projectDir
	pidInfo.ConfigPath = m.configPath
	pidInfo.InstanceID = instanceID
	pidInfo.NetOffset = m.netOffset
	pidInfo.ProcessIdentity = process.ProcessIdentity(spawnResult.PID)
	_ = process.WritePID(pidDir, pidInfo)
	_ = process.UpdateRuntime(pidInfo)

	// Wait for health.
	if svc.Config.HealthCheck != "" {
		time.Sleep(2 * time.Second) // Docker containers need a moment.
		result := m.waitHealth(ctx, svc)
		if !result.OK {
			_ = svc.SetState(service.StateFailed, "health check failed")
			m.cleanupFailedStart(svc, pidDir)
			tail, _ := logger.Tail(logsDir, svc.ID, logTailLines)
			return Action{
				Service:  svc.ID,
				Action:   "failed",
				Error:    "health check timeout",
				LogsTail: tail,
				Elapsed:  time.Since(start).Truncate(time.Millisecond).String(),
			}
		}
		if svc.Config.Container != "" {
			if container, inspectErr := docker.InspectContainer(ctx, m.dockerContainerName(svc)); inspectErr == nil {
				pidInfo.ContainerID = container.ID
				pidInfo.ContainerName = container.Name
				pidInfo.ContainerProjectID = container.ProjectID
				_ = process.WritePID(pidDir, pidInfo)
				_ = process.UpdateRuntime(pidInfo)
			}
		}
		svc.LastLatency = result.Latency
	}

	_ = svc.SetState(service.StateAlive, "")
	return Action{Service: svc.ID, Action: "started", Elapsed: time.Since(start).Truncate(time.Millisecond).String()}
}

func (m *Manager) startNode(ctx context.Context, svc *service.Service) Action {
	start := time.Now()
	_ = svc.SetState(service.StateStarting, "")

	logsDir := m.stateDir(m.cfg.Settings.LogsDir)
	pidDir := m.stateDir(m.cfg.Settings.PIDDir)

	_ = logger.EnsureDir(logsDir)
	_ = logger.Clear(logsDir, svc.ID)

	instanceID := process.NewInstanceID()
	result, err := process.Spawn(process.SpawnOpts{
		Command:  svc.Config.Command,
		Title:    m.processTitle(svc.ID, instanceID),
		Env:      m.spawnEnvFor(svc.Config, svc.ID, instanceID),
		Dir:      m.rootDir,
		LogFile:  logger.LogPath(logsDir, svc.ID),
		EnvCache: m.envCache,
	})
	if err != nil {
		_ = svc.SetState(service.StateFailed, err.Error())
		return Action{Service: svc.ID, Action: "failed", Error: err.Error()}
	}

	svc.PID = result.PID
	svc.PGID = result.PGID
	svc.StartedAt = start

	// Write rich PID file.
	pidInfo := process.NewPIDInfo(svc.ID, result.PID, result.PGID, svc.Config.Command)
	pidInfo.ProjectID = m.projectID
	pidInfo.ProjectRoot = m.projectDir
	pidInfo.ConfigPath = m.configPath
	pidInfo.InstanceID = instanceID
	pidInfo.NetOffset = m.netOffset
	pidInfo.ProcessIdentity = process.ProcessIdentity(result.PID)
	_ = process.WritePID(pidDir, pidInfo)
	_ = process.UpdateRuntime(pidInfo)

	// Reap the child as soon as it exits so a crash is visible immediately
	// instead of silently waiting out the full health-check timeout below.
	exited := make(chan *os.ProcessState, 1)
	go func() {
		state, _ := result.Process.Wait()
		exited <- state
	}()

	// Wait for health check.
	if svc.Config.HealthCheck != "" {
		hr := m.waitHealthOrExit(ctx, svc, exited)
		if !hr.OK {
			_ = svc.SetState(service.StateFailed, "health check failed")
			m.cleanupFailedStart(svc, pidDir)
			tail, _ := logger.Tail(logsDir, svc.ID, logTailLines)
			errMsg := fmt.Sprintf("health check timeout after %s", m.startTimeout())
			if hr.Error != nil {
				errMsg = hr.Error.Error()
			}
			return Action{
				Service:  svc.ID,
				Action:   "failed",
				Error:    errMsg,
				LogsTail: tail,
				Elapsed:  time.Since(start).Truncate(time.Millisecond).String(),
			}
		}
		svc.LastLatency = hr.Latency

	}

	_ = svc.SetState(service.StateAlive, "")
	return Action{Service: svc.ID, Action: "started", Elapsed: time.Since(start).Truncate(time.Millisecond).String()}
}

// cleanupFailedStart makes a failed start transactional: once health startup
// fails, its process group must not survive as an untracked retrying clone.
func (m *Manager) cleanupFailedStart(svc *service.Service, pidDir string) {
	if svc.Config.Type == config.ServiceTypeDocker && svc.Config.StopCommand != "" {
		if stopResult, err := process.Spawn(process.SpawnOpts{Command: svc.Config.StopCommand, Dir: m.rootDir}); err == nil {
			_, _ = stopResult.Process.Wait()
		}
	}
	if svc.Config.Type == config.ServiceTypeDocker && svc.Config.StopCommand == "" && svc.Config.Container != "" {
		_ = docker.StopContainer(context.Background(), m.dockerContainerName(svc))
	}
	if svc.PGID > 0 {
		_ = process.KillGroupWithPID(svc.PGID, svc.PID, defaultGracePeriod)
	} else if svc.Config.Port > 0 {
		_ = process.KillPort(svc.Config.Port)
	}
	_ = process.RemovePID(pidDir, svc.ID)
	_ = process.RemoveRuntime(m.projectID, svc.ID)
	svc.PID = 0
	svc.PGID = 0
}

// dockerContainerName follows the devservices convention used by offset
// configs: container names are suffixed with KB_NET_OFFSET so parallel
// projects never inspect or stop the base project's container.
func (m *Manager) dockerContainerName(svc *service.Service) string {
	if svc.Config.Container == "" || m.netOffset == 0 {
		return svc.Config.Container
	}
	return svc.Config.Container + strconv.Itoa(m.netOffset)
}

func (m *Manager) waitHealth(ctx context.Context, svc *service.Service) health.Result {
	probe := health.ClassifyServiceProbe(svc.Config.HealthCheck, svc.Config.Socket, 3*time.Second)
	checker := health.NewChecker(
		probe,
		time.Duration(m.cfg.Settings.HealthCheckInterval)*time.Millisecond,
		m.startTimeout(),
	)
	return checker.WaitHealthy(ctx)
}

// waitHealthOrExit polls the health probe like waitHealth, but also races
// against the child process exiting. A crash surfaces immediately with the
// process's exit status instead of silently burning the full health-check
// timeout waiting on a port that will never open.
func (m *Manager) waitHealthOrExit(ctx context.Context, svc *service.Service, exited <-chan *os.ProcessState) health.Result {
	probe := health.ClassifyServiceProbe(svc.Config.HealthCheck, svc.Config.Socket, 3*time.Second)
	checker := health.NewChecker(
		probe,
		time.Duration(m.cfg.Settings.HealthCheckInterval)*time.Millisecond,
		m.startTimeout(),
	)

	healthDone := make(chan health.Result, 1)
	go func() { healthDone <- checker.WaitHealthy(ctx) }()

	select {
	case hr := <-healthDone:
		return hr
	case state := <-exited:
		desc := "process exited"
		if state != nil {
			desc = fmt.Sprintf("process exited: %s", state.String())
		}
		return health.Result{OK: false, Error: fmt.Errorf("%s", desc)}
	}
}

func (m *Manager) startTimeout() time.Duration {
	return time.Duration(m.cfg.Settings.StartTimeout) * time.Millisecond
}

// Stop stops the specified services.
func (m *Manager) Stop(ctx context.Context, targets []string, cascade, force bool) *Result {
	return m.withLock(func() *Result {
		return m.stopInternal(ctx, targets, cascade, force)
	})
}

// withDependents returns targets plus their (transitive) dependents, de-duped.
// Used by cascade stop/restart so a service is never left running against a
// dependency that is being restarted.
func (m *Manager) withDependents(targets []string) []string {
	out := make([]string, len(targets))
	copy(out, targets)
	for _, t := range targets {
		for _, d := range m.cfg.Dependents(t) {
			if !contains(out, d) {
				out = append(out, d)
			}
		}
	}
	return out
}

func (m *Manager) stopInternal(_ context.Context, targets []string, cascade, force bool) *Result {
	toStop := make([]string, len(targets))
	copy(toStop, targets)

	if cascade {
		toStop = m.withDependents(targets)
	}

	var actions []Action
	pidDir := m.stateDir(m.cfg.Settings.PIDDir)

	// Stop in reverse dependency order — dependents first.
	for i := len(toStop) - 1; i >= 0; i-- {
		id := toStop[i]
		svc := m.services[id]
		state := svc.GetState()

		if state == service.StateDead && !force {
			actions = append(actions, Action{Service: id, Action: "skipped", Reason: "already stopped"})
			continue
		}

		_ = svc.SetState(service.StateStopping, "")

		switch {
		case svc.Config.Type == config.ServiceTypeDocker && svc.Config.StopCommand != "":
			if stopResult, spawnErr := process.Spawn(process.SpawnOpts{Command: svc.Config.StopCommand, Dir: m.rootDir}); spawnErr == nil {
				// Stop commands may target detached containers. Wait for the
				// command to finish before reporting the service stopped, otherwise
				// an immediate restart can race the old container and leak it.
				_, _ = stopResult.Process.Wait()
			}
		case svc.PGID > 0:
			_ = process.KillGroup(svc.PGID, defaultGracePeriod)
		case svc.Config.Port > 0 && force:
			_ = process.KillPort(svc.Config.Port)
		}

		_ = process.RemovePID(pidDir, id)
		_ = process.RemoveRuntime(m.projectID, id)
		// Remove unix socket file on stop (best-effort — ignore errors).
		if svc.Config.Socket != "" {
			_ = os.Remove(svc.Config.Socket)
		}
		_ = svc.SetState(service.StateDead, "")
		svc.PID = 0
		svc.PGID = 0

		actions = append(actions, Action{Service: id, Action: "stopped"})
	}

	return &Result{OK: true, Actions: actions}
}

// isPortOccupied returns true if a TCP listener is already bound to the given port.
// Used as a pre-flight check before spawning a service to avoid a misleading
// "started" result when another process is already holding the port.
func isPortOccupied(port int) bool {
	addr := fmt.Sprintf("localhost:%d", port)
	conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// Restart stops then starts services, with optional cascade.
func (m *Manager) Restart(ctx context.Context, targets []string, cascade, force bool) *Result {
	return m.withLock(func() *Result {
		// Expand to dependents UP FRONT so the same set is both stopped and
		// started. A cascade restart stops a service's dependents (so they don't
		// run against a mid-restart dependency); they must then be started again.
		// Restarting only `targets` while stopping `targets + dependents` was the
		// bug — dependents were cascade-stopped and never brought back.
		restartSet := targets
		if cascade {
			restartSet = m.withDependents(targets)
		}
		// Set is already expanded, so stop without re-cascading.
		stopResult := m.stopInternal(ctx, restartSet, false, force)
		time.Sleep(500 * time.Millisecond)
		startResult := m.startInternal(ctx, restartSet, force)

		allActions := make([]Action, 0, len(stopResult.Actions)+len(startResult.Actions))
		allActions = append(allActions, stopResult.Actions...)
		allActions = append(allActions, startResult.Actions...)
		return &Result{
			OK:      startResult.OK,
			Actions: allActions,
			Hint:    startResult.Hint,
		}
	})
}

// Ensure brings targets to alive state idempotently.
// Already alive → skip. Dead → start. Failed → restart.
func (m *Manager) Ensure(ctx context.Context, targets []string) *Result {
	return m.withLock(func() *Result {
		var actions []Action
		toStart := make([]string, 0)

		for _, id := range targets {
			svc := m.services[id]
			state := svc.GetState()

			switch state {
			case service.StateAlive:
				actions = append(actions, Action{Service: id, Action: "skipped", Reason: "already alive"})
			case service.StateFailed:
				_ = svc.SetState(service.StateDead, "")
				toStart = append(toStart, id)
			default:
				toStart = append(toStart, id)
			}
		}

		if len(toStart) > 0 {
			result := m.startInternal(ctx, toStart, true)
			actions = append(actions, result.Actions...)
			if !result.OK {
				return &Result{OK: false, Actions: actions, Hint: result.Hint}
			}
		}

		return &Result{OK: true, Actions: actions}
	})
}

// Ready blocks until all targets are alive or timeout expires.
func (m *Manager) Ready(ctx context.Context, targets []string, timeout time.Duration) *Result {
	deadline := time.After(timeout)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		allAlive := true
		for _, id := range targets {
			svc := m.services[id]
			if svc.GetState() != service.StateAlive {
				allAlive = false
				break
			}
		}

		if allAlive {
			var actions []Action
			for _, id := range targets {
				actions = append(actions, Action{Service: id, Action: "ready"})
			}
			return &Result{OK: true, Actions: actions}
		}

		select {
		case <-ctx.Done():
			return &Result{OK: false, Hint: "cancelled"}
		case <-deadline:
			var actions []Action
			for _, id := range targets {
				svc := m.services[id]
				state := svc.GetState()
				if state != service.StateAlive {
					actions = append(actions, Action{
						Service: id,
						Action:  "not_ready",
						Error:   fmt.Sprintf("state: %s", state),
					})
				}
			}
			return &Result{OK: false, Actions: actions, Hint: fmt.Sprintf("timeout after %s waiting for services", timeout)}
		case <-ticker.C:
			// continue polling
		}
	}
}

// Status returns the current state of all services.
func (m *Manager) Status() *StatusResult {
	result := &StatusResult{
		OK:       true,
		Services: make(map[string]ServiceStatus),
	}

	for id, svc := range m.services {
		state := svc.GetState()
		ss := ServiceStatus{
			State:   state.String(),
			Port:    svc.Config.Port,
			URL:     serviceAddress(svc.Config),
			Deps:    svc.Config.DependsOn,
			Detail:  svc.GetDetail(),
			LogFile: logger.LogPath(m.stateDir(m.cfg.Settings.LogsDir), id),
		}
		if svc.Config.Type == config.ServiceTypeDocker && svc.Config.Container != "" {
			ss.ContainerName = m.dockerContainerName(svc)
			ss.ContainerRunning = docker.ContainerRunning(ss.ContainerName)
			if info, readErr := process.ReadPID(m.stateDir(m.cfg.Settings.PIDDir), id); readErr == nil && info != nil {
				ss.ContainerID = info.ContainerID
				ss.ContainerOwned = info.ContainerProjectID == m.projectID && info.ContainerProjectID != ""
			}
		}

		// A failed/dead TCP service is often caused by a process outside kb-dev
		// holding its configured port. Surface the exact PID and command so the
		// user can clean up the right process instead of guessing or using a
		// broad kill command.
		if svc.Config.Port > 0 && (state == service.StateFailed || state == service.StateDead) {
			for _, pid := range process.GetListenerPIDs(svc.Config.Port) {
				if pid == svc.PID {
					continue
				}
				ss.PortOccupant = &PortOccupant{PID: pid, Command: process.CommandLine(pid)}
				if ss.Detail == "" {
					ss.Detail = fmt.Sprintf("port %d is occupied by PID %d", svc.Config.Port, pid)
				}
				ss.Cleanup = fmt.Sprintf("kb-dev stop %s --force", id)
				break
			}
		}

		// Resolved dependency states.
		if len(svc.Config.DependsOn) > 0 {
			ss.DepsState = make(map[string]string)
			for _, dep := range svc.Config.DependsOn {
				if depSvc, ok := m.services[dep]; ok {
					ss.DepsState[dep] = depSvc.GetState().String()
				}
			}
		}

		if state == service.StateAlive || state == service.StateStarting {
			ss.PID = svc.PID
			ss.PGID = svc.PGID
			if !svc.StartedAt.IsZero() {
				ss.StartedAt = svc.StartedAt.Format(time.RFC3339)
				ss.Uptime = time.Since(svc.StartedAt).Truncate(time.Second).String()
			}
		}

		if state == service.StateAlive && svc.LastLatency > 0 {
			ss.Health = &ServiceHealth{
				OK:      true,
				Latency: svc.LastLatency.Truncate(time.Millisecond).String(),
				Slow:    svc.LastLatency > slowThreshold,
			}
		}

		// Resource usage (CPU/memory) for alive processes.
		if svc.PID > 0 && (state == service.StateAlive || state == service.StateStarting) {
			if ru := process.GetResourceUsage(svc.PID); ru != nil {
				ss.Resources = &ResourceUsage{
					CPU:    fmt.Sprintf("%.1f%%", ru.CPUPercent),
					Memory: process.FormatMemory(ru.RSSBytes),
					RSS:    ru.RSSBytes,
				}
			}
		}

		result.Services[id] = ss

		// Count states.
		switch state {
		case service.StateAlive:
			result.Summary.Alive++
		case service.StateStarting:
			result.Summary.Starting++
		case service.StateFailed:
			result.Summary.Failed++
		case service.StateStopping:
			result.Summary.Stopping++
		default:
			result.Summary.Dead++
		}
	}

	result.Summary.Total = len(m.services)
	if records, err := process.ListRuntime(); err == nil {
		for _, record := range records {
			if record.ProjectID != m.projectID {
				continue
			}
			managed := m.services[record.Service]
			if process.IsAlive(record.PID) {
				if record.ProcessIdentity != "" && record.ProcessIdentity != process.ProcessIdentity(record.PID) {
					result.RuntimeAnomaly = append(result.RuntimeAnomaly, RuntimeAnomaly{
						Service: record.Service, PID: record.PID, PGID: record.PGID, Instance: record.InstanceID,
						State: "stale-runtime", Reason: "PID was reused by another process",
						Action: fmt.Sprintf("inspect PID %d; remove stale runtime record", record.PID),
					})
					continue
				}
				if managed == nil || managed.PID != record.PID {
					result.RuntimeAnomaly = append(result.RuntimeAnomaly, RuntimeAnomaly{
						Service: record.Service, PID: record.PID, PGID: record.PGID, Instance: record.InstanceID,
						State: "orphaned", Reason: "owned process has no matching PID state",
						Action: fmt.Sprintf("kb-dev --project %s stop %s --force", m.projectDir, record.Service),
					})
				}
			} else {
				result.RuntimeAnomaly = append(result.RuntimeAnomaly, RuntimeAnomaly{
					Service: record.Service, PID: record.PID, PGID: record.PGID, Instance: record.InstanceID,
					State: "stale-runtime", Reason: "owned process is no longer alive",
					Action: "run status again to reconcile and remove the stale record",
				})
			}
		}
	}
	if len(result.RuntimeAnomaly) > 0 {
		result.OK = false
	}
	return result
}

// Health runs health probes on all services and returns results.
func (m *Manager) Health() *HealthResult {
	result := &HealthResult{
		OK:       true,
		Services: make(map[string]*ServiceHealth),
	}

	ctx := context.Background()

	for id, svc := range m.services {
		if svc.Config.HealthCheck == "" {
			// No health check configured — skip, don't mark as failed.
			continue
		}

		probe := health.ClassifyProbe(svc.Config.HealthCheck, 3*time.Second)
		r := probe.Execute(ctx)

		sh := &ServiceHealth{OK: r.OK}
		if r.OK {
			sh.Latency = r.Latency.Truncate(time.Millisecond).String()
			sh.Slow = r.Latency > slowThreshold
		}
		result.Services[id] = sh
		if !r.OK {
			result.OK = false
		}
	}

	return result
}

// Events returns the event channel for streaming.
func (m *Manager) Events() <-chan Event {
	return m.events
}

// GetService returns a service by ID.
func (m *Manager) GetService(id string) *service.Service {
	return m.services[id]
}

// Config returns the manager's config.
func (m *Manager) Config() *config.Config {
	return m.cfg
}

// RootDir returns the workspace root directory.
func (m *Manager) RootDir() string {
	return m.rootDir
}

// ProjectDir returns the project root whose runtime config is used by services.
func (m *Manager) ProjectDir() string {
	return m.projectDir
}

// LogPath returns the project-scoped log file for a service. Keeping this on
// Manager ensures shared platform directories cannot accidentally read another
// worktree's logs.
func (m *Manager) LogPath(serviceID string) string {
	return logger.LogPath(m.stateDir(m.cfg.Settings.LogsDir), serviceID)
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
