package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// RunOptions controls the scheduler behaviour.
type RunOptions struct {
	Tasks       []string // task names to run (in order)
	Packages    []workspace.Package
	NoCache     bool
	LiveOutput  bool // stream stdout/stderr while running (disables parallel output)
	Concurrency int  // upper bound on parallel tasks; memory admission may run fewer
	WSRoot      string
	CacheRoot   string // this worktree's .kb/devkit/: task state and logs (objects and manifests live in cache.SharedRoot)
	Affected    bool   // selection came from --affected
	// DefaultSelection is true when the caller named no target (no --packages,
	// --closure-of or --affected). Packages of categories declared
	// `defaultBuild: false` then keep their own build task out of the run.
	DefaultSelection bool

	// MemoryProbe reads host memory for admission. Nil disables memory
	// admission (the concurrency cap alone applies).
	MemoryProbe MemoryProbe
	// SampleInterval is the period of OnSample; zero disables sampling. Sampling
	// also needs run.task_memory_mb, since samples describe memory admission.
	SampleInterval time.Duration
	// AdmissionPollInterval overrides how often waiting tasks re-read the probe.
	AdmissionPollInterval time.Duration
	// AdmissionSettle overrides how long a started task's memory is reserved
	// before the host is trusted to show it.
	AdmissionSettle time.Duration
	// OnSample receives periodic admission/resource samples.
	OnSample func(AdmissionSample)

	// OnResult is called immediately when each (pkg, task) finishes.
	// Called from the scheduler goroutine — must be safe to print to stdout.
	// total is the total number of (pkg, task) nodes scheduled.
	OnResult func(r TaskResult, done, total int)
	// OnHeartbeat is called once per interval for each running task.
	OnHeartbeat func(packageName, taskName string, elapsed time.Duration)
}

// RunResult is the aggregate result of a scheduler run.
type RunResult struct {
	OK               bool
	Results          []TaskResult
	BlockedTasks     []BlockedTask
	scheduledTasks   []TaskIdentity
	notAffectedTasks []TaskIdentity
	// SkippedBuilds names the packages whose build was left out because their
	// category is declared `defaultBuild: false` and nothing targeted them.
	SkippedBuilds []string `json:"skippedBuilds,omitempty"`
}

func (r RunResult) Summary() (RunSummary, error) {
	s := RunSummary{
		BlockedTasks: append([]BlockedTask{}, r.BlockedTasks...),
	}
	accounted := make(map[nodeKey]struct{}, len(r.Results)+len(r.BlockedTasks)+len(r.notAffectedTasks))
	for _, res := range r.Results {
		accounted[nodeKey{pkg: res.Package, task: res.Task}] = struct{}{}
		switch {
		case res.Cached:
			s.Cached++
		case res.OK:
			s.Passed++
		default:
			s.Failed++
		}
	}
	s.Blocked = len(r.BlockedTasks)
	for _, task := range r.BlockedTasks {
		accounted[nodeKey{pkg: task.Package, task: task.Task}] = struct{}{}
	}
	for _, task := range r.notAffectedTasks {
		accounted[nodeKey{pkg: task.Package, task: task.Task}] = struct{}{}
	}
	s.NotAffected = len(r.notAffectedTasks)
	s.Scheduled = len(r.scheduledTasks)
	var unaccounted []TaskIdentity
	for _, task := range r.scheduledTasks {
		if _, ok := accounted[nodeKey{pkg: task.Package, task: task.Task}]; !ok {
			unaccounted = append(unaccounted, task)
		}
	}
	if len(unaccounted) > 0 || s.Passed+s.Failed+s.Cached+s.Blocked+s.NotAffected != s.Scheduled {
		sort.Slice(unaccounted, func(i, j int) bool {
			if unaccounted[i].Package == unaccounted[j].Package {
				return unaccounted[i].Task < unaccounted[j].Task
			}
			return unaccounted[i].Package < unaccounted[j].Package
		})
		return s, &RunAccountingError{UnaccountedTasks: unaccounted}
	}
	return s, nil
}

// TaskIdentity identifies one scheduled package/task pair.
type TaskIdentity struct {
	Package string
	Task    string
}

// RunAccountingError identifies graph nodes with no terminal scheduler outcome.
type RunAccountingError struct {
	UnaccountedTasks []TaskIdentity
}

func (e *RunAccountingError) Error() string {
	return "scheduled tasks have no terminal outcome"
}

// RunSummary partitions every scheduled task by its execution outcome.
type RunSummary struct {
	Scheduled    int           `json:"scheduled"`
	Passed       int           `json:"passed"`
	Failed       int           `json:"failed"`
	Cached       int           `json:"cached"`
	Blocked      int           `json:"blocked"`
	NotAffected  int           `json:"notAffected"`
	BlockedTasks []BlockedTask `json:"blockedTasks"`
}

// BlockedTask records a scheduled task prevented from running by a failed task.
type BlockedTask struct {
	Package          string `json:"package"`
	Task             string `json:"task"`
	BlockedByPackage string `json:"blockedByPackage"`
	BlockedByTask    string `json:"blockedByTask"`
}

// TaskGraphError reports a declared workspace task dependency that cannot be
// represented because its package has no matching task variant.
type TaskGraphError struct {
	Package        string
	Task           string
	Dependency     string
	DependencyTask string
}

func (e *TaskGraphError) Error() string {
	return fmt.Sprintf("workspace task dependency has no matching task variant: %s %s needs %s %s", e.Package, e.Task, e.Dependency, e.DependencyTask)
}

// Run builds the (package × task) DAG and executes it in topological order.
// Packages in the same layer with no inter-task dependencies run in parallel.
func Run(ws *workspace.Workspace, cfg *config.DevkitConfig, opts RunOptions) (RunResult, error) {
	if len(opts.Tasks) == 0 {
		return RunResult{}, fmt.Errorf("no tasks specified")
	}

	pkgs := opts.Packages
	if len(pkgs) == 0 {
		pkgs = ws.Packages
	}
	if containsTask(opts.Tasks, "build") {
		expanded, err := expandBuildDependencyClosure(pkgs, ws.Packages, func(pkg workspace.Package) bool {
			def := ResolvePackageTaskDef(ws, cfg, "build", pkg)
			return def != nil && containsTask(def.Deps, "^build")
		})
		if err != nil {
			return RunResult{}, err
		}
		pkgs = expanded
	}
	selectedPackageNames := make(map[string]bool, len(pkgs))
	for _, pkg := range pkgs {
		selectedPackageNames[pkg.Name] = true
	}

	// Validate all requested tasks exist in config (at least one variant).
	for _, name := range opts.Tasks {
		if _, ok := cfg.Tasks[name]; !ok {
			return RunResult{}, fmt.Errorf("unknown task %q — add it to devkit.yaml tasks: section", name)
		}
	}

	// Build DAG of (pkg, task) nodes — only for packages with a matching variant.
	var skippedBuilds []string
	var seed seedFilter
	if opts.DefaultSelection && containsTask(opts.Tasks, "build") {
		for _, pkg := range pkgs {
			if category, ok := cfg.Workspace.FindCategory(pkg.Category); ok && !category.BuiltByDefault() {
				skippedBuilds = append(skippedBuilds, pkg.Name)
			}
		}
		skipped := make(map[string]bool, len(skippedBuilds))
		for _, name := range skippedBuilds {
			skipped[name] = true
		}
		seed = func(pkg workspace.Package, task string) bool { return task == "build" && skipped[pkg.Name] }
	}
	nodes, err := buildDAGSeeded(pkgs, opts.Tasks, cfg, ws, seed)
	if err != nil {
		return RunResult{}, err
	}
	if err := validateTaskGraph(nodes); err != nil {
		return RunResult{}, err
	}
	var notAffectedTasks []TaskIdentity
	allNodes := nodes
	if opts.Affected {
		allNodes, err = buildDAG(ws.Packages, opts.Tasks, cfg, ws)
		if err != nil {
			return RunResult{}, err
		}
		if err := validateTaskGraph(allNodes); err != nil {
			return RunResult{}, err
		}
		for key := range allNodes {
			if !selectedPackageNames[key.pkg] {
				notAffectedTasks = append(notAffectedTasks, TaskIdentity{Package: key.pkg, Task: key.task})
			}
		}
	}

	// Initialize execution state only after the full task graph is known to be acyclic.
	cacheRoot := opts.CacheRoot
	if cacheRoot == "" {
		cacheRoot = ".kb/devkit"
	}
	// Objects and manifests are shared by every worktree of the repository;
	// task state and logs describe this worktree's runs and stay under cacheRoot.
	sharedRoot, err := cache.SharedRoot(opts.WSRoot)
	if err != nil {
		return RunResult{}, fmt.Errorf("cache init: %w", err)
	}
	objects, err := cache.NewLocalStore(sharedRoot)
	if err != nil {
		return RunResult{}, fmt.Errorf("cache init: %w", err)
	}
	manifests := cache.NewManifestStore(sharedRoot)
	states := cache.NewStateStore(cacheRoot)
	globalInputDigest, ownedInputDigests, dependencyDigests, err := workspaceInputDigests(ws)
	if err != nil {
		return RunResult{}, fmt.Errorf("cache inputs: %w", err)
	}
	executor := NewExecutor(objects, manifests, states, opts.WSRoot, cacheRoot, opts.LiveOutput)
	executor.globalInputDigest = globalInputDigest
	executor.ownedInputDigests = ownedInputDigests
	executor.dependencyDigests = dependencyDigests
	executor.onHeartbeat = opts.OnHeartbeat

	// Precompute direct workspace dep directories for each package in the run.
	// Used by HashInputs to resolve "^"-prefixed input patterns (e.g. "^dist/**").
	// We index the full workspace (not just pkgs) so that deps outside the current
	// filtered set are also resolved correctly.
	allPkgByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, p := range ws.Packages {
		allPkgByName[p.Name] = p
	}
	pkgDepDirs := make(map[nodeKey][]string, len(nodes))
	for _, p := range pkgs {
		for _, taskName := range opts.Tasks {
			def := ResolveTaskDef(cfg, taskName, p.Category)
			if def == nil {
				continue
			}
			depNames, err := WorkspaceDeps(p.Dir, allPkgByName)
			if err != nil {
				return RunResult{}, err
			}
			dirs := make([]string, 0, len(depNames))
			for _, name := range depNames {
				if dep, ok := allPkgByName[name]; ok {
					dirs = append(dirs, dep.Dir)
				}
			}
			pkgDepDirs[nodeKey{pkg: p.Name, task: taskName}] = dirs
		}
	}

	// Concurrency is an upper bound, never a promise: --concurrency flag >
	// devkit.yaml run.concurrency (clamped to the CPU count) > NumCPU-1.
	// Memory admission (run.task_memory_mb) may run fewer tasks.
	// Live output forces 1 to avoid interleaved lines.
	concurrency := opts.Concurrency
	if opts.LiveOutput {
		concurrency = 1
	} else if concurrency <= 0 {
		concurrency = cfg.Run.Concurrency
		if cpus := runtime.NumCPU(); concurrency > cpus {
			concurrency = cpus
		}
	}
	if concurrency <= 0 {
		concurrency = runtime.NumCPU()
		if concurrency > 1 {
			concurrency--
		}
	}

	gate := newAdmission(concurrency, cfg.Run.TaskMemoryMB, opts.MemoryProbe, opts.AdmissionPollInterval, opts.AdmissionSettle)
	executor.gate = gate
	// Samples describe memory admission; without a per-task estimate there is none.
	if opts.OnSample != nil && opts.SampleInterval > 0 && gate.taskBytes > 0 {
		stopSampling := make(chan struct{})
		sampled := make(chan struct{})
		go func() {
			defer close(sampled)
			ticker := time.NewTicker(opts.SampleInterval)
			defer ticker.Stop()
			opts.OnSample(gate.sample(time.Now()))
			for {
				select {
				case <-stopSampling:
					opts.OnSample(gate.sample(time.Now())) // final state of the run
					return
				case now := <-ticker.C:
					opts.OnSample(gate.sample(now))
				}
			}
		}()
		defer func() { close(stopSampling); <-sampled }()
	}

	// Execute layer by layer (Kahn's algorithm).
	inDegree := make(map[nodeKey]int, len(nodes))
	revDeps := make(map[nodeKey][]nodeKey)

	for k, n := range nodes {
		if _, ok := inDegree[k]; !ok {
			inDegree[k] = 0
		}
		for _, dep := range n.deps {
			inDegree[k]++
			revDeps[dep.to] = append(revDeps[dep.to], k)
		}
	}

	queue := make([]nodeKey, 0)
	for k, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, k)
		}
	}

	total := len(nodes)
	done := 0
	var allResults []TaskResult
	failed := false
	blockedBy := make(map[nodeKey]nodeKey)

	for len(queue) > 0 {
		layer := queue
		queue = nil

		var resultMu sync.Mutex
		complete := func(result TaskResult) {
			if opts.OnResult == nil {
				return
			}
			resultMu.Lock()
			defer resultMu.Unlock()
			done++
			opts.OnResult(result, done, total)
		}
		layerResults := runLayer(layer, nodes, executor, cfg, ws, opts.NoCache, concurrency, pkgDepDirs, complete)
		allResults = append(allResults, layerResults...)

		for _, r := range layerResults {
			key := nodeKey{r.Package, r.Task}
			if !r.OK && !r.Cached {
				failed = true
				markBlockedDependents(key, revDeps, blockedBy)
				continue
			}
			for _, dependent := range revDeps[key] {
				if blockedBy[dependent] != (nodeKey{}) {
					continue
				}
				inDegree[dependent]--
				if inDegree[dependent] == 0 {
					queue = append(queue, dependent)
				}
			}
		}
	}

	ok := true
	for _, r := range allResults {
		if !r.OK && !r.Cached {
			ok = false
			break
		}
	}

	blockedTasks := make([]BlockedTask, 0, len(blockedBy))
	for key, blocker := range blockedBy {
		blockedTasks = append(blockedTasks, BlockedTask{
			Package: key.pkg, Task: key.task,
			BlockedByPackage: blocker.pkg, BlockedByTask: blocker.task,
		})
		_ = states.SetDirty(key.pkg, key.task, "blocked_by_failure")
	}
	sort.Slice(blockedTasks, func(i, j int) bool {
		if blockedTasks[i].Package == blockedTasks[j].Package {
			return blockedTasks[i].Task < blockedTasks[j].Task
		}
		return blockedTasks[i].Package < blockedTasks[j].Package
	})
	result := RunResult{
		OK:               ok && !failed,
		Results:          allResults,
		BlockedTasks:     blockedTasks,
		SkippedBuilds:    skippedBuilds,
		scheduledTasks:   make([]TaskIdentity, 0, len(allNodes)),
		notAffectedTasks: notAffectedTasks,
	}
	for key := range allNodes {
		result.scheduledTasks = append(result.scheduledTasks, TaskIdentity{Package: key.pkg, Task: key.task})
	}
	if _, err := result.Summary(); err != nil {
		return RunResult{}, err
	}
	return result, nil
}

func markBlockedDependents(failed nodeKey, reverse map[nodeKey][]nodeKey, blockedBy map[nodeKey]nodeKey) {
	queue := append([]nodeKey(nil), reverse[failed]...)
	for len(queue) > 0 {
		dependent := queue[0]
		queue = queue[1:]
		if _, alreadyBlocked := blockedBy[dependent]; alreadyBlocked {
			continue
		}
		blockedBy[dependent] = failed
		queue = append(queue, reverse[dependent]...)
	}
}

func containsTask(tasks []string, wanted string) bool {
	for _, task := range tasks {
		if task == wanted {
			return true
		}
	}
	return false
}

// expandBuildDependencyClosure adds all upstream workspace dependencies needed
// to build the selected packages on a clean runner. Affected detection starts
// from changed packages and walks downstream; build ordering also needs the
// reverse direction so every dependency has its dist artifacts first.
// A package's dependencies are followed only when follows reports that its
// build task declares `^build`: a build that declares no prerequisite needs no
// dependency built, whatever its manifest lists for other tasks.
func expandBuildDependencyClosure(selected, all []workspace.Package, follows func(workspace.Package) bool) ([]workspace.Package, error) {
	byName := make(map[string]workspace.Package, len(all))
	for _, pkg := range all {
		byName[pkg.Name] = pkg
	}

	seen := make(map[string]bool, len(selected))
	queue := make([]workspace.Package, 0, len(selected))
	for _, pkg := range selected {
		if !seen[pkg.Name] {
			seen[pkg.Name] = true
			queue = append(queue, pkg)
		}
	}

	for len(queue) > 0 {
		pkg := queue[0]
		queue = queue[1:]
		if !follows(pkg) {
			continue
		}
		depNames, err := WorkspaceDeps(pkg.Dir, byName)
		if err != nil {
			return nil, err
		}
		for _, depName := range depNames {
			dep, ok := byName[depName]
			if ok && !seen[dep.Name] {
				seen[dep.Name] = true
				queue = append(queue, dep)
			}
		}
	}

	// Preserve workspace order for deterministic scheduling and output.
	result := make([]workspace.Package, 0, len(seen))
	for _, pkg := range all {
		if seen[pkg.Name] {
			result = append(result, pkg)
		}
	}
	return result, nil
}

// ─── DAG construction ─────────────────────────────────────────────────────────

type nodeKey struct {
	pkg  string // package name
	task string
}

type dagNode struct {
	pkg  workspace.Package
	task string
	deps []taskDependencyEdge
}

type taskDependencyEdge struct {
	from nodeKey
	to   nodeKey
	kind WorkspaceDependencyKind
}

type WorkspaceDependencyKind string

const (
	DependenciesKind     WorkspaceDependencyKind = "dependencies"
	DevDependenciesKind  WorkspaceDependencyKind = "devDependencies"
	PeerDependenciesKind WorkspaceDependencyKind = "peerDependencies"
	TaskDependencyKind   WorkspaceDependencyKind = "task"
)

type WorkspaceDependency struct {
	Name string
	Kind WorkspaceDependencyKind
}

// TaskCycleEdge describes one directed prerequisite edge in a task cycle.
type TaskCycleEdge struct {
	From TaskIdentity
	To   TaskIdentity
	Kind WorkspaceDependencyKind
}

// TaskCycleError is returned before execution when the task graph contains a cycle.
type TaskCycleError struct {
	Edges []TaskCycleEdge
}

func (e *TaskCycleError) Error() string {
	return "workspace task dependency cycle: " + e.CycleDescription()
}

func (e *TaskCycleError) CycleDescription() string {
	if len(e.Edges) == 0 {
		return ""
	}
	var description strings.Builder
	identity := e.Edges[0].From
	fmt.Fprintf(&description, "%s:%s", identity.Package, identity.Task)
	for _, edge := range e.Edges {
		fmt.Fprintf(&description, " --%s--> %s:%s", edge.Kind, edge.To.Package, edge.To.Task)
	}
	return description.String()
}

func (e *TaskCycleError) DependencyEdges() []string {
	result := make([]string, 0, len(e.Edges))
	for _, edge := range e.Edges {
		result = append(result, formatTaskCycleEdge(edge))
	}
	return result
}

func formatTaskCycleEdge(edge TaskCycleEdge) string {
	return fmt.Sprintf("%s:%s --%s--> %s:%s", edge.From.Package, edge.From.Task, edge.Kind, edge.To.Package, edge.To.Task)
}

// seedFilter reports (package, task) pairs the caller leaves out of the
// initial selection. Such a pair still runs when a selected task declares it as
// a prerequisite.
type seedFilter func(pkg workspace.Package, task string) bool

func buildDAG(
	pkgs []workspace.Package,
	taskNames []string,
	cfg *config.DevkitConfig,
	ws *workspace.Workspace,
) (map[nodeKey]dagNode, error) {
	return buildDAGSeeded(pkgs, taskNames, cfg, ws, nil)
}

func buildDAGSeeded(
	pkgs []workspace.Package,
	taskNames []string,
	cfg *config.DevkitConfig,
	ws *workspace.Workspace,
	omit seedFilter,
) (map[nodeKey]dagNode, error) {
	// Build package name → Package map.
	pkgByName := make(map[string]workspace.Package, len(pkgs))
	for _, p := range pkgs {
		pkgByName[p.Name] = p
	}

	// Build dep map: package name → all direct workspace dependencies with their manifest kind.
	pkgDeps, err := buildPkgDepMap(pkgs, pkgByName)
	if err != nil {
		return nil, err
	}

	nodes := make(map[nodeKey]dagNode)
	var pending []nodeKey
	for _, p := range pkgs {
		for _, taskName := range taskNames {
			if omit != nil && omit(p, taskName) {
				continue
			}
			def := ResolvePackageTaskDef(ws, cfg, taskName, p)
			if def == nil {
				// No variant for this package category — skip silently.
				continue
			}
			k := nodeKey{p.Name, taskName}
			nodes[k] = dagNode{pkg: p, task: taskName}
			pending = append(pending, k)
		}
	}

	// Declared task dependencies are graph edges even when callers request only
	// the dependent task by name.
	for next := 0; next < len(pending); next++ {
		k := pending[next]
		n := nodes[k]
		def := ResolvePackageTaskDef(ws, cfg, k.task, n.pkg)
		if err := validatePackageScriptTask(n.pkg, k.task, def.Command); err != nil {
			return nil, err
		}
		var deps []taskDependencyEdge
		for _, dep := range def.Deps {
			workspaceDependency := strings.HasPrefix(dep, "^")
			depTask := strings.TrimPrefix(dep, "^")
			if workspaceDependency {
				// ^build = run 'build' for every workspace dependency first.
				for _, dependency := range pkgDeps[k.pkg] {
					depPkgName := dependency.Name
					depPkg, exists := pkgByName[depPkgName]
					if !exists {
						continue
					}
					depKey := nodeKey{depPkgName, depTask}
					if _, hasNode := nodes[depKey]; !hasNode {
						absent, err := dependencyTaskIsAbsent(ws, cfg, depTask, depPkg)
						if err != nil {
							return nil, err
						}
						if absent {
							continue
						}
						if ResolvePackageTaskDef(ws, cfg, depTask, depPkg) == nil {
							return nil, &TaskGraphError{Package: k.pkg, Task: k.task, Dependency: depPkgName, DependencyTask: depTask}
						}
						nodes[depKey] = dagNode{pkg: depPkg, task: depTask}
						pending = append(pending, depKey)
					}
					deps = append(deps, taskDependencyEdge{from: k, to: depKey, kind: dependency.Kind})
				}
			} else {
				// "build" = run 'build' for this same package first.
				depKey := nodeKey{k.pkg, depTask}
				if _, hasNode := nodes[depKey]; !hasNode {
					if ResolvePackageTaskDef(ws, cfg, depTask, n.pkg) == nil {
						return nil, &TaskGraphError{Package: k.pkg, Task: k.task, Dependency: k.pkg, DependencyTask: depTask}
					}
					nodes[depKey] = dagNode{pkg: n.pkg, task: depTask}
					pending = append(pending, depKey)
				}
				deps = append(deps, taskDependencyEdge{from: k, to: depKey, kind: TaskDependencyKind})
			}
		}

		n.deps = deps
		nodes[k] = n
	}

	return nodes, nil
}

func validateTaskGraph(nodes map[nodeKey]dagNode) error {
	if cycle := findTaskDependencyCycle(nodes); len(cycle) > 0 {
		return &TaskCycleError{Edges: cycle}
	}
	return nil
}

func findTaskDependencyCycle(nodes map[nodeKey]dagNode) []TaskCycleEdge {
	keys := make([]nodeKey, 0, len(nodes))
	for key := range nodes {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return nodeKeyLess(keys[i], keys[j]) })

	state := make(map[nodeKey]uint8, len(nodes))
	var path []nodeKey
	var pathEdges []taskDependencyEdge
	var found []TaskCycleEdge
	var visit func(nodeKey) bool
	visit = func(key nodeKey) bool {
		state[key] = 1
		path = append(path, key)
		deps := append([]taskDependencyEdge(nil), nodes[key].deps...)
		sort.Slice(deps, func(i, j int) bool {
			if deps[i].to != deps[j].to {
				return nodeKeyLess(deps[i].to, deps[j].to)
			}
			return deps[i].kind < deps[j].kind
		})
		for _, edge := range deps {
			switch state[edge.to] {
			case 0:
				pathEdges = append(pathEdges, edge)
				if visit(edge.to) {
					return true
				}
				pathEdges = pathEdges[:len(pathEdges)-1]
			case 1:
				start := 0
				for path[start] != edge.to {
					start++
				}
				for _, pathEdge := range pathEdges[start:] {
					found = append(found, taskCycleEdge(pathEdge))
				}
				found = append(found, taskCycleEdge(edge))
				return true
			}
		}
		path = path[:len(path)-1]
		state[key] = 2
		return false
	}
	for _, key := range keys {
		if state[key] == 0 && visit(key) {
			return found
		}
	}
	return nil
}

func taskCycleEdge(edge taskDependencyEdge) TaskCycleEdge {
	return TaskCycleEdge{
		From: TaskIdentity{Package: edge.from.pkg, Task: edge.from.task},
		To:   TaskIdentity{Package: edge.to.pkg, Task: edge.to.task},
		Kind: edge.kind,
	}
}

func nodeKeyLess(left, right nodeKey) bool {
	if left.pkg == right.pkg {
		return left.task < right.task
	}
	return left.pkg < right.pkg
}

func validatePackageScriptTask(pkg workspace.Package, task, command string) error {
	parts := splitCommand(command)
	if len(parts) < 3 || filepath.Base(parts[0]) != "pnpm" || parts[1] != "run" {
		return nil
	}
	// pnpm run [flags] <script> [args]: flags precede the script name.
	// --if-present declares that a missing script is intended, so there is nothing to validate.
	script := ""
	for _, part := range parts[2:] {
		if part == "--if-present" {
			return nil
		}
		if !strings.HasPrefix(part, "-") {
			script = part
			break
		}
	}
	if script == "" {
		return nil
	}
	declared, err := packageDeclaresScript(pkg, script)
	if err != nil {
		return fmt.Errorf("DevKit task %q on %q: %w", task, pkg.Name, err)
	}
	if !declared {
		return fmt.Errorf("DevKit task %q for package %q invokes missing package script %q; declare it in package.json or remove the task assignment, then rerun kb-devkit run %s --packages %s", task, pkg.Name, script, task, pkg.Name)
	}
	return nil
}

// packageDeclaresScript reports whether the package manifest declares the named script.
// A package without a manifest declares no scripts.
func packageDeclaresScript(pkg workspace.Package, script string) (bool, error) {
	manifestPath := filepath.Join(pkg.Dir, "package.json")
	data, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read package manifest %s: %w", manifestPath, err)
	}
	var manifest struct {
		Scripts map[string]json.RawMessage `json:"scripts"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return false, fmt.Errorf("parse package manifest %s: %w", manifestPath, err)
	}
	_, declared := manifest.Scripts[script]
	return declared, nil
}

// dependencyTaskIsAbsent reports whether a workspace dependency has nothing to
// run for depTask: no DevKit variant and no package script of that name, as for
// a source-only package. A declared script without a variant is a configuration
// gap that must stay a graph error, so the dependency is never silently dropped.
func dependencyTaskIsAbsent(ws *workspace.Workspace, cfg *config.DevkitConfig, depTask string, dep workspace.Package) (bool, error) {
	if ResolvePackageTaskDef(ws, cfg, depTask, dep) != nil {
		return false, nil
	}
	declared, err := packageDeclaresScript(dep, depTask)
	if err != nil {
		return false, err
	}
	return !declared, nil
}

// buildPkgDepMap reads package.json deps for each package.
// Returns: pkg name → list of workspace dep names.
// Self-references (package depending on itself) are filtered out to prevent
// cycles in the DAG — e.g. @kb-labs/devkit listing itself in devDependencies.
func buildPkgDepMap(pkgs []workspace.Package, pkgByName map[string]workspace.Package) (map[string][]WorkspaceDependency, error) {
	goModulePackages, err := readWorkspaceGoModulePackages(pkgByName)
	if err != nil {
		return nil, err
	}
	result := make(map[string][]WorkspaceDependency, len(pkgs))
	for _, p := range pkgs {
		raw := readWorkspaceDependencyEdges(p.Dir, pkgByName)
		goEdges, err := readGoWorkspaceDependencyEdges(p.Dir, pkgByName, goModulePackages)
		if err != nil {
			return nil, err
		}
		raw = append(raw, goEdges...)
		filtered := raw[:0]
		for _, dependency := range raw {
			if dependency.Name != p.Name {
				filtered = append(filtered, dependency)
			}
		}
		result[p.Name] = filtered
	}
	return result, nil
}

type goModuleEdit struct {
	Module struct {
		Path string `json:"Path"`
	} `json:"Module"`
	Require []struct {
		Path string `json:"Path"`
	} `json:"Require"`
	Replace []struct {
		Old struct {
			Path string `json:"Path"`
		} `json:"Old"`
		New struct {
			Path    string `json:"Path"`
			Version string `json:"Version"`
		} `json:"New"`
	} `json:"Replace"`
}

func readGoModuleEdit(dir string) (goModuleEdit, error) {
	var module goModuleEdit
	command := exec.Command("go", "mod", "edit", "-json")
	command.Dir = dir
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "GOTOOLCHAIN=local", "GOWORK=off", "GOFLAGS=", "GOENV=off"}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return module, fmt.Errorf("read Go workspace dependencies in %s: %w: %s", dir, err, strings.TrimSpace(stderr.String()))
	}
	if err := json.Unmarshal(output, &module); err != nil {
		return module, fmt.Errorf("parse Go workspace dependencies in %s: %w", dir, err)
	}
	return module, nil
}

func readWorkspaceGoModulePackages(pkgByName map[string]workspace.Package) (map[string]workspace.Package, error) {
	modules := make(map[string]workspace.Package)
	for _, pkg := range pkgByName {
		if _, err := os.Stat(filepath.Join(pkg.Dir, "go.mod")); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return nil, err
		}
		module, err := readGoModuleEdit(pkg.Dir)
		if err != nil {
			return nil, err
		}
		if module.Module.Path == "" {
			return nil, fmt.Errorf("Go module in %s has no declared module path", pkg.Dir)
		}
		modules[module.Module.Path] = pkg
	}
	return modules, nil
}

func readGoWorkspaceDependencyEdges(dir string, pkgByName map[string]workspace.Package, goModulePackages map[string]workspace.Package) ([]WorkspaceDependency, error) {
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	module, err := readGoModuleEdit(dir)
	if err != nil {
		return nil, err
	}
	required := make(map[string]struct{}, len(module.Require))
	for _, requirement := range module.Require {
		required[requirement.Path] = struct{}{}
	}
	edgesByName := make(map[string]WorkspaceDependency)
	for modulePath := range required {
		if pkg, ok := goModulePackages[modulePath]; ok {
			edgesByName[pkg.Name] = WorkspaceDependency{Name: pkg.Name, Kind: DependenciesKind}
		}
	}
	for _, replacement := range module.Replace {
		if replacement.New.Version != "" {
			continue
		}
		replacementDir := replacement.New.Path
		if !filepath.IsAbs(replacementDir) {
			replacementDir = filepath.Join(dir, replacementDir)
		}
		replacementDir = filepath.Clean(replacementDir)
		for name, pkg := range pkgByName {
			if filepath.Clean(pkg.Dir) == replacementDir {
				edgesByName[name] = WorkspaceDependency{Name: name, Kind: DependenciesKind}
				break
			}
		}
	}
	edges := make([]WorkspaceDependency, 0, len(edgesByName))
	for _, edge := range edgesByName {
		edges = append(edges, edge)
	}
	return edges, nil
}

// readWorkspaceDeps returns workspace-internal dependency names for a package.
// Reads dependencies, optionalDependencies, devDependencies, and peerDependencies;
// all four sections can contain workspace packages needed for build ordering.
func readWorkspaceDependencyEdges(dir string, pkgByName map[string]workspace.Package) []WorkspaceDependency {
	data, err := os.ReadFile(dir + "/package.json")
	if err != nil {
		return nil
	}

	var pkg struct {
		Dependencies         map[string]string `json:"dependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		PeerDependencies     map[string]string `json:"peerDependencies"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil
	}

	sections := []struct {
		kind WorkspaceDependencyKind
		deps map[string]string
	}{
		{kind: DependenciesKind, deps: pkg.Dependencies},
		{kind: DependenciesKind, deps: pkg.OptionalDependencies},
		{kind: DevDependenciesKind, deps: pkg.DevDependencies},
		{kind: PeerDependenciesKind, deps: pkg.PeerDependencies},
	}
	var result []WorkspaceDependency
	for _, section := range sections {
		for name := range section.deps {
			if _, ok := pkgByName[name]; ok {
				result = append(result, WorkspaceDependency{Name: name, Kind: section.kind})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].Kind < result[j].Kind
		}
		return result[i].Name < result[j].Name
	})
	return result
}

// WorkspaceDeps returns direct workspace dependency names for a package dir.
// Reads dependencies, optionalDependencies, devDependencies, and peerDependencies.
// pkgByName must cover all workspace packages to correctly filter internal deps.
func WorkspaceDeps(pkgDir string, pkgByName map[string]workspace.Package) ([]string, error) {
	reader, err := NewWorkspaceDependencyReader(pkgByName)
	if err != nil {
		return nil, err
	}
	return reader.WorkspaceDeps(pkgDir)
}

// WorkspaceDependencyReader resolves pnpm and Go workspace edges against one package set.
type WorkspaceDependencyReader struct {
	pkgByName        map[string]workspace.Package
	goModulePackages map[string]workspace.Package
}

// NewWorkspaceDependencyReader resolves Go module paths once for repeated package lookups.
func NewWorkspaceDependencyReader(pkgByName map[string]workspace.Package) (*WorkspaceDependencyReader, error) {
	goModulePackages, err := readWorkspaceGoModulePackages(pkgByName)
	if err != nil {
		return nil, err
	}
	return &WorkspaceDependencyReader{pkgByName: pkgByName, goModulePackages: goModulePackages}, nil
}

// WorkspaceDeps returns all direct workspace dependencies for pkgDir.
func (reader *WorkspaceDependencyReader) WorkspaceDeps(pkgDir string) ([]string, error) {
	edges := readWorkspaceDependencyEdges(pkgDir, reader.pkgByName)
	goEdges, err := readGoWorkspaceDependencyEdges(pkgDir, reader.pkgByName, reader.goModulePackages)
	if err != nil {
		return nil, err
	}
	edges = append(edges, goEdges...)
	seen := make(map[string]struct{}, len(edges))
	result := make([]string, 0, len(edges))
	for _, edge := range edges {
		if _, exists := seen[edge.Name]; exists {
			continue
		}
		seen[edge.Name] = struct{}{}
		result = append(result, edge.Name)
	}
	return result, nil
}

// WorkspaceProdDeps returns direct workspace:* dependency names for a package dir,
// excluding devDependencies. Used by bundle --prod to build minimal Docker closures.
func WorkspaceProdDeps(pkgDir string, pkgByName map[string]workspace.Package) ([]string, error) {
	reader, err := NewWorkspaceDependencyReader(pkgByName)
	if err != nil {
		return nil, err
	}
	return reader.WorkspaceProdDeps(pkgDir)
}

// WorkspaceProdDeps returns direct production workspace dependencies for pkgDir.
func (reader *WorkspaceDependencyReader) WorkspaceProdDeps(pkgDir string) ([]string, error) {
	edges := readWorkspaceDependencyEdges(pkgDir, reader.pkgByName)
	goEdges, err := readGoWorkspaceDependencyEdges(pkgDir, reader.pkgByName, reader.goModulePackages)
	if err != nil {
		return nil, err
	}
	edges = append(edges, goEdges...)
	seen := make(map[string]struct{}, len(edges))
	result := make([]string, 0, len(edges))
	for _, edge := range edges {
		if edge.Kind == DevDependenciesKind {
			continue
		}
		if _, exists := seen[edge.Name]; exists {
			continue
		}
		seen[edge.Name] = struct{}{}
		result = append(result, edge.Name)
	}
	return result, nil
}

// ─── Layer execution ──────────────────────────────────────────────────────────

func runLayer(
	layer []nodeKey,
	nodes map[nodeKey]dagNode,
	executor *Executor,
	cfg *config.DevkitConfig,
	ws *workspace.Workspace,
	noCache bool,
	concurrency int,
	pkgDepDirs map[nodeKey][]string,
	onComplete func(TaskResult),
) []TaskResult {
	results := make([]TaskResult, len(layer))
	var wg sync.WaitGroup
	// sem bounds the CPU-bound work of a layer (hashing, cache restore); memory
	// admission is separate and wraps only the process launch in Executor.Run.
	sem := make(chan struct{}, concurrency)

	for i, k := range layer {
		i, k := i, k
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			n := nodes[k]
			def := ResolvePackageTaskDef(ws, cfg, k.task, n.pkg)
			if def == nil {
				// Should not happen — node was created only if variant matched.
				results[i] = TaskResult{Package: k.pkg, Task: k.task, OK: false, Error: "no variant matched"}
				onComplete(results[i])
				return
			}
			results[i] = executor.Run(n.pkg, *def, noCache, pkgDepDirs[k])
			onComplete(results[i])
		}()
	}

	wg.Wait()
	return results
}

// ─── Dirty packages ───────────────────────────────────────────────────────────

// DirtyPackages returns packages whose requested task inputs differ from their
// last successful run, plus their workspace dependents. Missing or failed task
// state is dirty; Git diffs are reserved for the explicit diff-only selector.
func DirtyPackages(ws *workspace.Workspace, cfg *config.DevkitConfig, tasks []string, cacheRoot string) ([]workspace.Package, error) {
	if len(tasks) == 0 {
		return nil, nil
	}
	sharedRoot, err := cache.SharedRoot(ws.Root)
	if err != nil {
		return nil, fmt.Errorf("cache init: %w", err)
	}
	states := cache.NewStateStore(cacheRoot)
	runtimeFingerprint := cache.RuntimeFingerprint()
	pkgByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, p := range ws.Packages {
		pkgByName[p.Name] = p
	}

	var changed []workspace.Package
	var globalInputDigest string
	var ownedInputDigests, dependencyDigests map[string]string
	inputDigestReady := false
	for _, p := range ws.Packages {
		for _, task := range tasks {
			def := ResolvePackageTaskDef(ws, cfg, task, p)
			if def == nil {
				continue
			}
			state, exists := states.Get(p.Name, task)
			if !exists || state.Kind != cache.TaskStateClean {
				changed = append(changed, p)
				break
			}
			if !inputDigestReady {
				globalInputDigest, ownedInputDigests, dependencyDigests, err = workspaceInputDigests(ws)
				if err != nil {
					return nil, fmt.Errorf("cache inputs: %w", err)
				}
				inputDigestReady = true
			}
			depNames, err := WorkspaceDeps(p.Dir, pkgByName)
			if err != nil {
				return nil, err
			}
			depDirs := make([]string, 0, len(depNames))
			for _, name := range depNames {
				if dep, ok := pkgByName[name]; ok {
					depDirs = append(depDirs, dep.Dir)
				}
			}
			inputHash, err := hashTaskInputs(p, *def, depDirs, runtimeFingerprint, globalInputDigest, ownedInputDigests[p.Name], dependencyDigests[p.Name])
			if err != nil {
				// Schedule the package so Executor reports the input read failure
				// through the task's catalogued error and recovery hint.
				changed = append(changed, p)
				break
			}
			if state.InputHash != inputHash || !taskOutputsMatch(p.Dir, *def, cache.NewManifestStore(sharedRoot), inputHash, p.Name) {
				changed = append(changed, p)
				break
			}
		}
	}
	return packagesAndDependents(ws, changed)
}

// taskOutputsMatch checks the content and modes owned by the successful cache manifest.
func taskOutputsMatch(pkgDir string, def TaskDef, manifests *cache.ManifestStore, inputHash, pkgName string) bool {
	if len(def.Outputs) == 0 {
		return true
	}
	manifest, ok := manifests.Get(pkgName, def.Name, inputHash)
	if !ok || manifest.ExitCode != 0 || len(manifest.Outputs) == 0 {
		return false
	}
	for _, ref := range manifest.Outputs {
		if ref.Mode == nil {
			return false
		}
		file := filepath.Join(pkgDir, ref.Path)
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() || uint32(info.Mode().Perm()) != *ref.Mode {
			return false
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return false
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != ref.Object {
			return false
		}
	}
	return true
}

func workspaceInputDigests(ws *workspace.Workspace) (string, map[string]string, map[string]string, error) {
	unownedFiles, ownedFiles, tracked, err := ws.TrackedFileOwnership()
	if err != nil {
		return "", nil, nil, err
	}
	globalDigest, err := cache.ContentDigest(ws.Root, unownedFiles, tracked)
	if err != nil {
		return "", nil, nil, err
	}
	ownedDigests := make(map[string]string, len(ownedFiles))
	for name, files := range ownedFiles {
		digest, err := cache.ContentDigest(ws.Root, files, tracked)
		if err != nil {
			return "", nil, nil, err
		}
		ownedDigests[name] = digest
	}
	pkgByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, pkg := range ws.Packages {
		pkgByName[pkg.Name] = pkg
	}
	dependencies := make(map[string][]string, len(ws.Packages))
	for _, pkg := range ws.Packages {
		deps, err := WorkspaceDeps(pkg.Dir, pkgByName)
		if err != nil {
			return "", nil, nil, err
		}
		dependencies[pkg.Name] = deps
	}
	dependencyDigests := make(map[string]string, len(ws.Packages))
	for _, pkg := range ws.Packages {
		visited := make(map[string]bool)
		queue := append([]string(nil), dependencies[pkg.Name]...)
		closure := make(map[string]string)
		for len(queue) > 0 {
			name := queue[0]
			queue = queue[1:]
			if visited[name] {
				continue
			}
			visited[name] = true
			if digest, ok := ownedDigests[name]; ok {
				closure[name] = digest
			}
			queue = append(queue, dependencies[name]...)
		}
		dependencyDigests[pkg.Name] = cache.CombineContentDigests(closure)
	}
	return globalDigest, ownedDigests, dependencyDigests, nil
}

// AffectedRunPackages selects by configured Git diff only when diffOnly is
// explicit. Normal --affected runs use last-successful input hashes.
func AffectedRunPackages(ws *workspace.Workspace, cfg *config.DevkitConfig, tasks []string, cacheRoot string, diffOnly bool) ([]workspace.Package, error) {
	if diffOnly {
		selection, err := AffectedPackages(ws, cfg)
		if err != nil {
			return nil, err
		}
		return selection.Packages, nil
	}
	return DirtyPackages(ws, cfg, tasks, cacheRoot)
}

// ─── Affected packages ────────────────────────────────────────────────────────

// AffectedSelection is the package set and reason chosen for a configured diff.
type AffectedSelection struct {
	Packages []workspace.Package
	Reason   string
}

// AffectedPackages returns all packages affected by current changes:
// directly changed packages + all their downstream dependents (BFS). If any
// changed path is not owned by a discovered package, it selects the full graph.
//
// Strategy is controlled by cfg.Affected.Strategy (default: "git").
//
//	git        — single `git diff --name-only HEAD` from ws root
//	submodules — walks .gitmodules, runs git diff inside each submodule
//	command    — runs cfg.Affected.Command, reads file paths from stdout
func AffectedPackages(ws *workspace.Workspace, cfg *config.DevkitConfig) (AffectedSelection, error) {
	strategy := cfg.Affected.Strategy
	if strategy == "" {
		strategy = "git"
	}

	changedFiles, err := collectChangedFiles(ws.Root, strategy, cfg.Affected.Command)
	if err != nil {
		return AffectedSelection{}, fmt.Errorf("affected: collect changed files: %w", err)
	}
	return selectAffectedPackages(ws, changedFiles, cfg.Affected.FullInputs)
}

// AffectedPackagesFromFiles selects workspace packages from a produced changed-file manifest.
func AffectedPackagesFromFiles(ws *workspace.Workspace, files []string, fullInputs []string) (AffectedSelection, error) {
	changedFiles := make([]string, 0, len(files))
	for _, file := range files {
		if file == "" {
			return AffectedSelection{}, fmt.Errorf("changed-file manifest contains an empty path")
		}
		if !filepath.IsAbs(file) {
			file = filepath.Join(ws.Root, file)
		}
		changedFiles = append(changedFiles, filepath.Clean(file))
	}
	return selectAffectedPackages(ws, changedFiles, fullInputs)
}

func selectAffectedPackages(ws *workspace.Workspace, changedFiles []string, fullInputs []string) (AffectedSelection, error) {
	directlyChanged := make(map[string]bool)
	unowned := make([]string, 0)
	fullInputSet := make(map[string]struct{}, len(fullInputs))
	for _, input := range fullInputs {
		fullInputSet[filepath.ToSlash(filepath.Clean(input))] = struct{}{}
	}
	sharedChanges := make([]string, 0)
	for _, absFile := range changedFiles {
		relative, err := filepath.Rel(ws.Root, absFile)
		if err != nil {
			return AffectedSelection{}, fmt.Errorf("affected: make changed path relative: %w", err)
		}
		relative = filepath.ToSlash(relative)
		if _, ok := fullInputSet[relative]; ok {
			sharedChanges = append(sharedChanges, relative)
		}
		if pkg, ok := ws.PackageByPath(absFile); ok {
			directlyChanged[pkg.Name] = true
		} else {
			unowned = append(unowned, relative)
		}
	}
	if len(unowned) > 0 {
		sort.Strings(unowned)
		return AffectedSelection{Packages: append([]workspace.Package(nil), ws.Packages...), Reason: "full: unowned path " + unowned[0]}, nil
	}
	if len(sharedChanges) > 0 {
		sort.Strings(sharedChanges)
		return AffectedSelection{Packages: append([]workspace.Package(nil), ws.Packages...), Reason: "full: configured shared input " + sharedChanges[0]}, nil
	}

	if len(directlyChanged) == 0 {
		return AffectedSelection{}, nil
	}

	var direct []workspace.Package
	for _, p := range ws.Packages {
		if directlyChanged[p.Name] {
			direct = append(direct, p)
		}
	}
	packages, err := packagesAndDependents(ws, direct)
	if err != nil {
		return AffectedSelection{}, err
	}
	return AffectedSelection{Packages: packages}, nil
}

func packagesAndDependents(ws *workspace.Workspace, direct []workspace.Package) ([]workspace.Package, error) {
	pkgByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, p := range ws.Packages {
		pkgByName[p.Name] = p
	}
	reverseDeps := make(map[string][]string, len(ws.Packages))
	for _, p := range ws.Packages {
		deps, err := WorkspaceDeps(p.Dir, pkgByName)
		if err != nil {
			return nil, err
		}
		for _, dep := range deps {
			reverseDeps[dep] = append(reverseDeps[dep], p.Name)
		}
	}
	visited := make(map[string]bool)
	queue := make([]string, 0, len(direct))
	for _, p := range direct {
		if !visited[p.Name] {
			visited[p.Name] = true
			queue = append(queue, p.Name)
		}
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, dependent := range reverseDeps[current] {
			if !visited[dependent] {
				visited[dependent] = true
				queue = append(queue, dependent)
			}
		}
	}
	var result []workspace.Package
	for _, p := range ws.Packages {
		if visited[p.Name] {
			result = append(result, p)
		}
	}
	return result, nil
}

// collectChangedFiles returns absolute paths of changed files using the given strategy.
func collectChangedFiles(wsRoot, strategy, command string) ([]string, error) {
	switch strategy {
	case "git":
		return gitChangedFiles(wsRoot, wsRoot)
	case "submodules":
		return submoduleChangedFiles(wsRoot)
	case "command":
		if command == "" {
			return nil, fmt.Errorf("affected.strategy=command requires affected.command to be set")
		}
		return commandChangedFiles(wsRoot, command)
	default:
		return nil, fmt.Errorf("unknown affected.strategy %q (valid: git, submodules, command)", strategy)
	}
}

// gitChangedFiles runs `git diff --name-only HEAD` in dir and returns absolute paths.
func gitChangedFiles(wsRoot, dir string) ([]string, error) {
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "git", Executable: "git", Args: []string{"diff", "--name-only", "HEAD"}, Dir: dir, Operation: toolchain.OperationVersionProbe})
	out := []byte(result.Stdout)
	if err != nil {
		// Also try staged files (for fresh repos with no HEAD)
		result2, err2 := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "git", Executable: "git", Args: []string{"diff", "--name-only", "--cached"}, Dir: dir, Operation: toolchain.OperationVersionProbe})
		if err2 != nil {
			return nil, err // return original error
		}
		out = []byte(result2.Stdout)
	}

	// Also include unstaged changes
	result3, err3 := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "git", Executable: "git", Args: []string{"diff", "--name-only"}, Dir: dir, Operation: toolchain.OperationVersionProbe})
	if err3 == nil {
		out = append(out, result3.Stdout...)
	}

	return parseFileList(wsRoot, dir, out), nil
}

// submoduleChangedFiles reads .gitmodules to find submodule roots,
// then runs git diff inside each one.
func submoduleChangedFiles(wsRoot string) ([]string, error) {
	roots, err := readSubmoduleRoots(wsRoot)
	if err != nil || len(roots) == 0 {
		// Fall back to single git diff in ws root
		return gitChangedFiles(wsRoot, wsRoot)
	}

	var all []string
	for _, root := range roots {
		files, err := gitChangedFiles(wsRoot, root)
		if err != nil {
			continue // skip repos with no commits yet
		}
		all = append(all, files...)
	}
	return all, nil
}

// commandChangedFiles executes a custom command and reads file paths from stdout.
func commandChangedFiles(wsRoot, command string) ([]string, error) {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty command")
	}
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: parts[0], Executable: parts[0], Args: parts[1:], Dir: wsRoot, Operation: toolchain.OperationWorkspaceTask})
	if err != nil {
		return nil, fmt.Errorf("command %q failed: %w", command, err)
	}
	return parseFileList(wsRoot, wsRoot, []byte(result.Stdout)), nil
}

// readSubmoduleRoots parses .gitmodules to find submodule absolute paths.
func readSubmoduleRoots(wsRoot string) ([]string, error) {
	data, err := os.ReadFile(wsRoot + "/.gitmodules")
	if err != nil {
		return nil, err
	}
	var roots []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "path = ") {
			rel := strings.TrimPrefix(line, "path = ")
			abs := wsRoot + "/" + strings.TrimSpace(rel)
			roots = append(roots, abs)
		}
	}
	return roots, nil
}

// parseFileList converts raw `git diff --name-only` output to absolute paths.
// Lines that are relative are resolved against repoRoot.
// Lines that are already absolute are used as-is.
func parseFileList(wsRoot, repoRoot string, raw []byte) []string {
	var result []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var abs string
		if strings.HasPrefix(line, "/") {
			abs = line
		} else {
			abs = repoRoot + "/" + line
		}
		if !seen[abs] {
			seen[abs] = true
			result = append(result, abs)
		}
	}
	_ = wsRoot // available for future use (e.g. relative path normalization)
	return result
}
