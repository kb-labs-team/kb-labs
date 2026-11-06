// Package proc owns supervised command trees, their live registry, and lifecycle events.
// It supports Linux and macOS. Windows has no implementation by design.
package proc

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/proc/child"
)

const (
	EventSchema         = "kb.proc-event/v2"
	stateEnv            = "KBLABS_CLIPROC_CONFIG"
	readyEnv            = "KBLABS_CLIPROC_READY_FD"
	keeperDispatchEnv   = "KBLABS_INTERNAL_PROC_KEEPER"
	keeperDispatchValue = "start-v1"
	runEnv              = "KBLABS_CLIPROC_RUN"
)

type OwnershipUnverifiedReason string

const OwnershipUnverifiedRunTokenClosed OwnershipUnverifiedReason = "run-token-closed-after-observation"

func init() {
	if os.Getenv(keeperDispatchEnv) == keeperDispatchValue {
		command.Exit(keeperMain())
	}
}

type EventType string

const (
	EventQueued       EventType = "queued"
	EventBlocked      EventType = "blocked"
	EventIdle         EventType = "idle"
	EventPressure     EventType = "pressure"
	EventPaused       EventType = "paused"
	EventResumed      EventType = "resumed"
	EventOverBudget   EventType = "over-budget"
	EventUngatedHeavy EventType = "ungated-heavy"
	EventStart        EventType = "start"
	EventStall        EventType = "stall"
	EventExit         EventType = "exit"
	EventLost         EventType = "lost"
	EventTeardown     EventType = "teardown"
)

type Config struct {
	StateDir    string
	Tag         string
	RunID       string
	LatestTag   string
	Stall       time.Duration
	StdoutPath  string
	StderrPath  string
	StdinPath   string
	SlotGroup   string
	Slots       int
	SlotWeight  int
	WaitGate    string
	HoldGate    string
	MinFree     uint64
	CostKey     string
	CostClass   CostClass
	Priority    int
	MemoryBytes uint64
	CPUsMin     int
	CPUsMax     int
	DiskBytes   uint64
	GrantedCPUs int
	Command     []string
	Dir         string
	Env         []string
	// CommandTempDir overrides TMPDIR, TMP, and TEMP for the supervised command.
	// The caller creates and owns this directory; empty keeps the proc run scratch.
	CommandTempDir   string
	CostKeyLeaseMode LeaseMode
	SharedLeasePaths []string
	// CleanEnv makes Env the complete environment for both the keeper and its command.
	CleanEnv bool
	Keep     []string
}

type Event struct {
	Schema                   string                       `json:"schema"`
	At                       time.Time                    `json:"at"`
	Type                     EventType                    `json:"type"`
	Status                   RunStatus                    `json:"status,omitempty"`
	RunID                    string                       `json:"run_id"`
	Tag                      string                       `json:"tag"`
	KeeperPID                int                          `json:"keeper_pid"`
	Command                  string                       `json:"command,omitempty"`
	Binary                   string                       `json:"binary,omitempty"`
	ProcessTree              []Process                    `json:"process_tree,omitempty"`
	ExitCode                 *int                         `json:"exit_code,omitempty"`
	Signal                   string                       `json:"signal,omitempty"`
	Error                    string                       `json:"error,omitempty"`
	Reason                   string                       `json:"reason,omitempty"`
	WaitingItems             []string                     `json:"waiting_items,omitempty"`
	Position                 int                          `json:"position,omitempty"`
	DiskNeedBytes            uint64                       `json:"disk_need_bytes,omitempty"`
	DiskFreeBytes            uint64                       `json:"disk_free_bytes,omitempty"`
	DurationMS               int64                        `json:"duration_ms,omitempty"`
	Leaves                   []Process                    `json:"leaves,omitempty"`
	Reaped                   []Process                    `json:"reaped,omitempty"`
	Unverified               []Process                    `json:"unverified,omitempty"`
	TeardownHistory          []ProcessIdentityEvidence    `json:"teardown_history,omitempty"`
	TeardownInventory        []ProcessTreeInventorySample `json:"teardown_inventory,omitempty"`
	TeardownInventoryOmitted int                          `json:"teardown_inventory_omitted,omitempty"`
	TeardownEvidenceOmitted  int                          `json:"teardown_evidence_omitted,omitempty"`
	MemoryBytes              uint64                       `json:"memory_bytes,omitempty"`
	CPUsMin                  int                          `json:"cpus_min,omitempty"`
	CPUsMax                  int                          `json:"cpus_max,omitempty"`
	DiskBytes                uint64                       `json:"disk_bytes,omitempty"`
	GrantedCPUs              int                          `json:"granted_cpus,omitempty"`
	PeakRSSBytes             uint64                       `json:"peak_rss_bytes,omitempty"`
	AverageCPU               float64                      `json:"average_cpu,omitempty"`
	MeasurementPartial       bool                         `json:"measurement_partial,omitempty"`
	LimitsAdvisory           string                       `json:"limits_advisory,omitempty"`
	OverBudget               bool                         `json:"over_budget,omitempty"`
	ResourceNotice           string                       `json:"resource_notice,omitempty"`
	CostClass                CostClass                    `json:"cost_class,omitempty"`
	PausedMS                 int64                        `json:"paused_ms,omitempty"`
	GovernorDecision         string                       `json:"governor_decision,omitempty"`
	Pressure                 HostResourceSnapshot         `json:"pressure,omitempty"`
	Remaining                []Process                    `json:"remaining,omitempty"`
	Resources                ResourceOutcomeSummary       `json:"resources,omitempty"`
}

type ResourceOutcomeSummary struct {
	Counts    map[string]int               `json:"counts,omitempty"`
	Remaining []ResourceOutcomeSummaryItem `json:"remaining,omitempty"`
	Omitted   int                          `json:"omitted,omitempty"`
}

type ResourceOutcomeSummaryItem struct {
	Resource Resource `json:"resource"`
	Outcome  string   `json:"outcome"`
}

type Run struct {
	PID       RecordedKeeperPID
	RunID     string
	StartedAt string
	stateDir  string
	cmd       *exec.Cmd
	wait      *processWait
	lifetime  *os.File
	record    record
	once      sync.Once
	err       error
	done      chan struct{}
	leases    []*FileLease
}

type processWait struct {
	done   chan struct{}
	result processWaitResult
}

// processWaitResult is published by the sole goroutine that calls Cmd.Wait.
// No other goroutine reads Cmd.ProcessState.
type processWaitResult struct {
	err    error
	status string
}

func startProcessWait(cmd *exec.Cmd) *processWait {
	wait := &processWait{done: make(chan struct{})}
	go func() {
		wait.result.err = cmd.Wait()
		if state := cmd.ProcessState; state != nil {
			wait.result.status = state.String()
		}
		close(wait.done)
	}()
	return wait
}

func (wait *processWait) outcome() processWaitResult {
	<-wait.done
	return wait.result
}

type KeeperSignalOutcome string

const (
	KeeperSignalRefusedCaller       KeeperSignalOutcome = "refused: caller"
	KeeperSignalRefusedUnverifiable KeeperSignalOutcome = "refused: caller ancestry unverifiable"
)

type KeeperSignalError struct {
	Outcome KeeperSignalOutcome
	PID     int
}

func (err *KeeperSignalError) Error() string {
	return fmt.Sprintf("proc: keeper signal %s for pid %d", err.Outcome, err.PID)
}

type RunStatus string

const (
	StatusRunning   RunStatus = "running"
	StatusQueued    RunStatus = "queued"
	StatusBlocked   RunStatus = "blocked"
	StatusStalled   RunStatus = "stalled"
	StatusPaused    RunStatus = "paused"
	StatusStarting  RunStatus = "starting"
	StatusCompleted RunStatus = "completed"
	StatusFailed    RunStatus = "failed"
	StatusDead      RunStatus = "dead"
	StatusLost      RunStatus = "lost"
	StatusDirty     RunStatus = "dirty"
)

// Terminal reports whether the run has reached an outcome that waiters should
// observe without continuing to poll.
func (status RunStatus) Terminal() bool {
	switch status {
	case StatusCompleted, StatusFailed, StatusDead, StatusLost, StatusDirty:
		return true
	case StatusRunning, StatusQueued, StatusBlocked, StatusStalled, StatusStarting, StatusPaused:
		return false
	}
	return false
}

type Process struct {
	PID                       int `json:"pid"`
	PPID                      int `json:"ppid"`
	processGroupID            int
	sessionID                 int
	sessionIDError            string
	processState              string
	Command                   string    `json:"command"` // OS process command name, never the argument vector.
	StartedAt                 time.Time `json:"started_at"`
	ElapsedMS                 int64     `json:"elapsed_ms"`
	Identity                  string    `json:"identity"`
	runMarker                 bool
	markerResult              string
	markerReadError           string
	Unverified                bool                      `json:"unverified,omitempty"`
	OwnershipUnverifiedReason OwnershipUnverifiedReason `json:"ownership_unverified_reason,omitempty"`
	uid                       uint32
	runToken                  bool
	tokenResult               string
	tokenReadError            string
	RSSBytes                  uint64  `json:"rss_bytes,omitempty"`
	CPUSeconds                float64 `json:"cpu_seconds,omitempty"`
	MetricsAvailable          bool    `json:"metrics_available,omitempty"`
}

type RunInfo struct {
	RunID              string            `json:"run_id"`
	Tag                string            `json:"tag"`
	PID                RecordedKeeperPID `json:"pid"`
	StartedAt          *time.Time        `json:"started_at,omitempty"`
	Identity           string            `json:"identity"`
	Status             RunStatus         `json:"status"`
	Command            []string          `json:"command"`
	Tree               []Process         `json:"tree"`
	SlotGroup          string            `json:"slot_group,omitempty"`
	SlotWeight         int               `json:"slot_weight,omitempty"`
	QueuePosition      int               `json:"queue_position,omitempty"`
	WaitReason         string            `json:"wait_reason,omitempty"`
	ElapsedMS          int64             `json:"elapsed_ms,omitempty"`
	StallMS            int64             `json:"stall_ms,omitempty"`
	ExitCode           *int              `json:"exit_code,omitempty"`
	Signal             string            `json:"signal,omitempty"`
	Error              string            `json:"error,omitempty"`
	CostKey            string            `json:"cost_key,omitempty"`
	CostClass          CostClass         `json:"cost_class"`
	Priority           int               `json:"priority"`
	MemoryBytes        uint64            `json:"memory_bytes,omitempty"`
	CPUsMin            int               `json:"cpus_min,omitempty"`
	CPUsMax            int               `json:"cpus_max,omitempty"`
	DiskBytes          uint64            `json:"disk_bytes,omitempty"`
	GrantedCPUs        int               `json:"granted_cpus,omitempty"`
	PeakRSSBytes       uint64            `json:"peak_rss_bytes"`
	AverageCPU         float64           `json:"average_cpu"`
	Paused             bool              `json:"paused"`
	PausedMS           int64             `json:"paused_ms,omitempty"`
	MeasurementPartial bool              `json:"measurement_partial,omitempty"`
	LimitsAdvisory     string            `json:"limits_advisory,omitempty"`
	OverBudget         bool              `json:"over_budget,omitempty"`
	ResourceNotice     string            `json:"resource_notice,omitempty"`
	DurationMS         int64             `json:"duration_ms,omitempty"`
	ResourceOutcomes   []Resource        `json:"resource_outcomes,omitempty"`
}

// RecordedKeeperPID is the keeper identity stored in a run record. Keeping it
// distinct from an arbitrary OS pid makes direct signaling of RunInfo.PID a
// compile-time error; callers use the proc signal owner instead.
type RecordedKeeperPID int

type Listing struct {
	Runs             []RunInfo            `json:"runs"`
	Host             HostResourceSnapshot `json:"host"`
	GovernorDecision string               `json:"governor_decision"`
	GovernorReason   string               `json:"governor_reason,omitempty"`
	Error            error                `json:"-"`
}

type treeCleanup struct {
	Reaped                  []Process
	Unverified              []Process
	Remaining               []Process
	History                 []ProcessIdentityEvidence
	Inventory               []ProcessTreeInventorySample
	InventorySamplesOmitted int
	err                     error
}

type ProcessIdentityEvidence struct {
	PID      int    `json:"pid"`
	PPID     int    `json:"ppid"`
	PGID     int    `json:"pgid"`
	SID      int    `json:"sid"`
	UID      uint32 `json:"uid"`
	Identity string `json:"identity"`
}

type cleanupClock interface {
	Now() time.Time
	Wait(time.Duration)
}

type wallCleanupClock struct{}

func (wallCleanupClock) Now() time.Time              { return time.Now() }
func (wallCleanupClock) Wait(duration time.Duration) { time.Sleep(duration) }

type ProcessTreeInventorySample struct {
	Index             int                                 `json:"index"`
	SnapshotErr       string                              `json:"snapshot_error,omitempty"`
	Processes         []ProcessTreeInventoryEvidence      `json:"processes"`
	RejectedCounts    []ProcessTreeInventoryRejectedCount `json:"rejected_counts,omitempty"`
	RejectedExamples  []ProcessTreeInventoryEvidence      `json:"rejected_examples,omitempty"`
	OmittedProcesses  int                                 `json:"omitted_processes,omitempty"`
	MembershipChanged bool                                `json:"membership_changed,omitempty"`
}

const maxTeardownInventorySamples = 4
const maxTeardownProcessesPerSample = 6
const maxTeardownRejectedExamples = 2

type ProcessTreeInventoryRejectedCount struct {
	Membership           string `json:"membership"`
	MarkerResult         string `json:"marker_result,omitempty"`
	TokenResult          string `json:"token_result,omitempty"`
	UIDClass             string `json:"uid_class"`
	PotentialSetuidOwner bool   `json:"potential_setuid_owner,omitempty"`
	Count                int    `json:"count"`
}

type ProcessTreeInventoryEvidence struct {
	PID                       int                       `json:"pid"`
	PPID                      int                       `json:"ppid"`
	PGID                      int                       `json:"pgid"`
	SID                       int                       `json:"sid"`
	SIDError                  string                    `json:"sid_error,omitempty"`
	UID                       uint32                    `json:"uid"`
	Identity                  string                    `json:"identity"`
	MarkerResult              string                    `json:"marker_result"`
	MarkerError               string                    `json:"marker_error,omitempty"`
	TokenResult               string                    `json:"token_result,omitempty"`
	TokenError                string                    `json:"token_error,omitempty"`
	OwnershipUnverifiedReason OwnershipUnverifiedReason `json:"ownership_unverified_reason,omitempty"`
	Membership                string                    `json:"membership"`
}

// processSource is the OS observation and signalling boundary used by every
// tree, liveness, and cleanup operation. Tests inject a source at this seam.
type processSource interface {
	Snapshot(runID string) ([]Process, error)
	Identity(pid int) (string, bool, error)
	Signal(pid int, identity string, signal syscall.Signal) error
}

type directChildSignalOwner interface {
	SignalDirectChild(process *os.Process, identity string, signal syscall.Signal) error
}

func signalCleanupTarget(source processSource, directChild *os.Process, process Process, signal syscall.Signal) error {
	if directChild != nil && directChild.Pid == process.PID {
		if owner, ok := source.(directChildSignalOwner); ok {
			// Only the keeper's unreaped direct child uses its process handle. On Darwin, non-child descendants retain the accepted identity-check/kill PID-reuse window.
			return owner.SignalDirectChild(directChild, process.Identity, signal)
		}
		return fmt.Errorf("process source cannot safely signal direct child %d through its handle", directChild.Pid)
	}
	return source.Signal(process.PID, process.Identity, signal)
}

type containedProcessSource interface {
	ContainedDescendants(root int, snapshot []Process) ([]Process, bool, error)
}

type processMetricsSource interface {
	Metrics(tree []Process) ([]Process, error)
}

func inspectIdentity(pid int) (string, bool, error) {
	return osProcessSource{}.Identity(pid)
}

func ProcessIdentity(pid int) (string, bool, error) {
	return inspectIdentity(pid)
}

// CurrentRunID returns the clikit run identity inherited by a supervised
// process. An empty value means the process was not started under clikit.
func CurrentRunID() string { return os.Getenv(runEnv) }

// AllocateRunID creates an identity that callers can persist before dispatch.
func AllocateRunID() (string, error) { return newID() }

// RunOwnsProcess reports whether a live clikit run owns the exact worker
// process identity. Run membership is established by the run ID, the live
// keeper PID/start identity from the registry, and the worker PID/start
// identity in that run's observed tree. Process-table and registry errors are
// returned so callers can preserve an explicit unknown state.
func RunOwnsProcess(stateDir, runID string, workerPID int, workerIdentity string) (bool, error) {
	if runID == "" || workerPID <= 0 || workerIdentity == "" {
		return false, errors.New("proc: run ownership requires run ID and worker PID/start identity")
	}
	listing := List(stateDir)
	if listing.Error != nil {
		return false, listing.Error
	}
	return runOwnsProcess(listing, runID, workerPID, workerIdentity), nil
}

// RunTagActive reports whether a nonterminal supervised run with the exact
// tag still has its recorded keeper identity alive.
func RunTagActive(stateDir, tag string) (bool, error) {
	if tag == "" {
		return false, errors.New("proc: run tag is required")
	}
	listing := List(stateDir)
	if listing.Error != nil {
		return false, listing.Error
	}
	return runTagActive(listing, tag), nil
}

func runTagActive(listing Listing, tag string) bool {
	for _, run := range listing.Runs {
		if run.RunID != "" && run.Tag == tag && run.PID > 0 && run.Identity != "" && !run.Status.Terminal() {
			return true
		}
	}
	return false
}

func runOwnsProcess(listing Listing, runID string, workerPID int, workerIdentity string) bool {
	for _, run := range listing.Runs {
		if run.RunID != runID || run.PID <= 0 || run.Identity == "" || run.Status.Terminal() {
			continue
		}
		for _, process := range run.Tree {
			if process.PID == workerPID && process.Identity == workerIdentity {
				return true
			}
		}
	}
	return false
}

func ProcessExists(pid int) (bool, error) {
	_, alive, err := ProcessIdentity(pid)
	return alive, err
}

func killTreeWithProtectedAncestors(root int, runID string, observed []Process, protected []ProcessIdentityEvidence) treeCleanup {
	return cleanupTreeWithProtectedSource(root, runID, observed, protected, osProcessSource{})
}

func killTreeWithProtectedAncestorsAndDirectChild(root int, runID string, observed []Process, protected []ProcessIdentityEvidence, directChild *os.Process) treeCleanup {
	return cleanupTreeWithProtectedSourceAndDirectChild(root, runID, observed, protected, osProcessSource{}, directChild)
}

func cleanupLostRun(rec record, source processSource) treeCleanup {
	recoverySource, authoritative, sourceErr := lostRunRecoverySource(rec, source)
	cleanup := cleanupTreeWithProtectedSource(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, recoverySource)
	cleanup.err = errors.Join(cleanup.err, sourceErr)
	cleanup.err = errors.Join(cleanup.err, removeRunToken(rec.RunID))
	if !authoritative && len(rec.Observed) == 0 && len(cleanup.Reaped) == 0 && len(cleanup.Unverified) == 0 && len(cleanup.Remaining) == 0 {
		cleanup.err = errors.Join(cleanup.err, errors.New("unverified/failed observation: lost run has no persisted owned process identity"))
	}
	return cleanup
}

type record struct {
	RunID              string                    `json:"run_id"`
	Tag                string                    `json:"tag"`
	LatestTag          string                    `json:"latest_tag,omitempty"`
	PID                int                       `json:"pid"`
	StartedAt          string                    `json:"started_at"`
	Command            []string                  `json:"command"`
	StateDir           string                    `json:"state_dir"`
	Status             RunStatus                 `json:"status,omitempty"`
	Error              string                    `json:"error,omitempty"`
	SlotGroup          string                    `json:"slot_group,omitempty"`
	Slots              int                       `json:"slots,omitempty"`
	SlotWeight         int                       `json:"slot_weight,omitempty"`
	QueueOrder         uint64                    `json:"queue_order,omitempty"`
	EnqueuedAt         time.Time                 `json:"enqueued_at,omitempty"`
	IdleReported       bool                      `json:"idle_reported,omitempty"`
	WaitReason         string                    `json:"wait_reason,omitempty"`
	WaitGate           string                    `json:"wait_gate,omitempty"`
	HoldGate           string                    `json:"hold_gate,omitempty"`
	MinFree            uint64                    `json:"min_free,omitempty"`
	StartedAtTime      time.Time                 `json:"started_at_time,omitempty"`
	LastOutputAt       time.Time                 `json:"last_output_at,omitempty"`
	StallMS            int64                     `json:"stall_ms,omitempty"`
	ExitCode           *int                      `json:"exit_code,omitempty"`
	Signal             string                    `json:"signal,omitempty"`
	DurationMS         int64                     `json:"duration_ms,omitempty"`
	Observed           []Process                 `json:"observed,omitempty"`
	ProtectedAncestors []ProcessIdentityEvidence `json:"protected_ancestors,omitempty"`
	CostKey            string                    `json:"cost_key,omitempty"`
	CostClass          CostClass                 `json:"cost_class"`
	Priority           int                       `json:"priority,omitempty"`
	MemoryBytes        uint64                    `json:"memory_bytes,omitempty"`
	CPUsMin            int                       `json:"cpus_min,omitempty"`
	CPUsMax            int                       `json:"cpus_max,omitempty"`
	DiskBytes          uint64                    `json:"disk_bytes,omitempty"`
	GrantedCPUs        int                       `json:"granted_cpus,omitempty"`
	PeakRSSBytes       uint64                    `json:"peak_rss_bytes,omitempty"`
	AverageCPU         float64                   `json:"average_cpu,omitempty"`
	MeasurementPartial bool                      `json:"measurement_partial,omitempty"`
	LimitsAdvisory     string                    `json:"limits_advisory,omitempty"`
	OverBudget         bool                      `json:"over_budget,omitempty"`
	ResourceNotice     string                    `json:"resource_notice,omitempty"`
	PausedAt           time.Time                 `json:"paused_at,omitempty"`
	PausedMS           int64                     `json:"paused_ms,omitempty"`
	Scratch            string                    `json:"scratch,omitempty"`
	ScratchDevice      uint64                    `json:"scratch_device,omitempty"`
	ScratchInode       uint64                    `json:"scratch_inode,omitempty"`
	Keep               []string                  `json:"keep,omitempty"`
	Resources          []Resource                `json:"resources,omitempty"`
}

type keeperConfig struct {
	Config
	RunID          string    `json:"run_id"`
	ParentPID      int       `json:"parent_pid"`
	ParentIdentity string    `json:"parent_identity"`
	RunStartedAt   time.Time `json:"run_started_at"`
}

type readyMessage struct {
	Record record `json:"record"`
	Error  string `json:"error,omitempty"`
}

type readyResult struct {
	record record
	err    error
}

type startupOutcomeKind uint8

const (
	startupReady startupOutcomeKind = iota
	startupKeeperExited
	startupCanceled
)

type startupOutcome struct {
	kind          startupOutcomeKind
	result        readyResult
	readyConsumed bool
}

// Cancellation wins when it arrives with readiness, so Start never publishes
// a Run after its caller has canceled.
func selectStartupOutcome(ctx context.Context, ready <-chan readyResult, keeperExited <-chan struct{}) startupOutcome {
	select {
	case <-ctx.Done():
		return startupOutcome{kind: startupCanceled}
	case result := <-ready:
		if ctx.Err() != nil {
			return startupOutcome{kind: startupCanceled, result: result, readyConsumed: true}
		}
		return startupOutcome{kind: startupReady, result: result}
	case <-keeperExited:
		return startupOutcome{kind: startupKeeperExited}
	}
}

// KeeperExitError reports that the keeper process exited before a valid ready
// handshake was observed.
type KeeperExitError struct {
	Status string
	Err    error
}

// AdmissionCanceledError reports cancellation while a run is waiting for admission.
type AdmissionCanceledError struct {
	WaitReason string
	Cause      error
}

func (e *AdmissionCanceledError) Error() string {
	if e.WaitReason == "" {
		return fmt.Sprintf("proc: admission cancelled: %v", e.Cause)
	}
	return fmt.Sprintf("proc: admission cancelled while %s: %v", e.WaitReason, e.Cause)
}

func (e *AdmissionCanceledError) Unwrap() error {
	return e.Cause
}

func (e *KeeperExitError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("proc: keeper exited before ready: %s: %v", e.Status, e.Err)
	}
	return fmt.Sprintf("proc: keeper exited before ready: %s", e.Status)
}

func (e *KeeperExitError) Unwrap() error {
	return e.Err
}

// Start launches this executable as the keeper helper.
func Start(ctx context.Context, cfg Config) (*Run, error) {
	return startWithHostResourceSource(ctx, cfg, systemHostResourceSource())
}

// CanonicalStateDir resolves a command-line state path before any keeper is started.
func CanonicalStateDir(stateDir string) (string, error) {
	if stateDir == "" {
		return "", errors.New("proc: state directory is required")
	}
	canonical, err := filepath.Abs(stateDir)
	if err != nil {
		return "", fmt.Errorf("proc: resolve state directory %q: %w", stateDir, err)
	}
	return canonical, nil
}

func startWithHostResourceSource(ctx context.Context, cfg Config, source HostResourceSource) (*Run, error) {
	if err := validateStartContext(ctx); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, diag.New("KB_RUNTIME_EXECUTABLE_PATH_UNAVAILABLE", "The current executable path could not be determined.", diag.WithReason(err.Error()))
	}
	if !filepath.IsAbs(cfg.StateDir) {
		return nil, errors.New("proc: state directory must be absolute before starting a keeper")
	}
	return startWithExecutable(ctx, cfg, source, executable)
}

func validateStartContext(ctx context.Context) error {
	if ctx != nil && ctx.Done() != nil {
		return nil
	}
	diagnostic, err := diag.FromCatalog("KB_RUNTIME_START_CONTEXT_NOT_CANCELLABLE", nil)
	if err != nil {
		return err
	}
	return diagnostic
}

func startWithExecutable(ctx context.Context, cfg Config, source HostResourceSource, executable string) (startedRun *Run, returnErr error) {
	if source == nil {
		return nil, errors.New("proc: resource source is required")
	}
	if err := validateCommandTempDir(cfg.CommandTempDir); err != nil {
		return nil, err
	}
	if executable == "" || cfg.StateDir == "" || cfg.Tag == "" || cfg.Stall <= 0 || cfg.StdoutPath == "" || cfg.StderrPath == "" || len(cfg.Command) == 0 {
		return nil, errors.New("proc: executable path, state directory, tag, positive stall duration, output paths, and command are required")
	}
	if cfg.CostClass == "" {
		cfg.CostClass = CostLight
	}
	if cfg.CostClass != CostLight && cfg.CostClass != CostHeavy {
		return nil, errors.New("proc: cost class must be light or heavy")
	}
	leases, err := acquireConfigLeases(cfg)
	if err != nil {
		return nil, err
	}
	leaseOwnershipTransferred := false
	defer func() {
		if !leaseOwnershipTransferred {
			returnErr = errors.Join(returnErr, closeFileLeases(leases))
		}
	}()
	if err := os.MkdirAll(liveRecordsDir(cfg.StateDir), 0o700); err != nil {
		return nil, fmt.Errorf("proc: create state directory: %w", err)
	}
	runID := cfg.RunID
	if runID == "" {
		runID, err = newID()
		if err != nil {
			return nil, fmt.Errorf("proc: create run id: %w", err)
		}
	}
	if _, err := runScratchPath(runID); err != nil {
		return nil, err
	}
	parentIdentity, ok, err := ProcessIdentity(os.Getpid())
	if err != nil {
		return nil, fmt.Errorf("proc: inspect supervisor process identity: %w", err)
	}
	if !ok {
		return nil, errors.New("proc: cannot identify supervisor process")
	}
	if err := reserveAdmission(ctx, cfg, runID, os.Getpid(), parentIdentity, source); err != nil {
		return nil, err
	}
	if err := withStateLock(cfg.StateDir, func() error {
		rec, err := readRecordLocked(cfg.StateDir, runID)
		if err != nil {
			return err
		}
		cfg.MemoryBytes, cfg.CPUsMin, cfg.CPUsMax, cfg.DiskBytes, cfg.GrantedCPUs = rec.MemoryBytes, rec.CPUsMin, rec.CPUsMax, rec.DiskBytes, rec.GrantedCPUs
		return nil
	}); err != nil {
		cleanupAdmission(cfg.StateDir, runID, err.Error())
		return nil, err
	}
	admissionPending := true
	defer func() {
		if admissionPending {
			cleanupAdmission(cfg.StateDir, runID, "start failed")
		}
	}()
	runStartedAt, err := processStartTimeBound()
	if err != nil {
		return nil, fmt.Errorf("proc: capture run start bound: %w", err)
	}
	kc := keeperConfig{Config: cfg, RunID: runID, ParentPID: os.Getpid(), ParentIdentity: parentIdentity, RunStartedAt: runStartedAt}
	encoded, err := json.Marshal(kc)
	if err != nil {
		return nil, fmt.Errorf("proc: encode keeper configuration: %w", err)
	}
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("proc: create keeper handshake: %w", err)
	}
	lifetimeRead, lifetimeWrite, err := os.Pipe()
	if err != nil {
		return nil, errors.Join(fmt.Errorf("proc: create launcher lifetime pipe: %w", err), readReady.Close(), writeReady.Close())
	}
	// The keeper gets only the read end; this launcher retains the sole writer
	// until Wait or process exit, so EOF is independent of the launcher's thread.
	lifetimeReaderClosed := false
	lifetimeTransferred := false
	defer func() {
		if !lifetimeReaderClosed {
			returnErr = errors.Join(returnErr, lifetimeRead.Close())
		}
		if !lifetimeTransferred {
			returnErr = errors.Join(returnErr, lifetimeWrite.Close())
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(fmt.Errorf("proc: start canceled: %w", err), readReady.Close(), writeReady.Close())
	}
	cmd := exec.Command(executable)
	keeperEnv := environmentFor(cfg, os.Environ())
	cmd.Env = append(keeperEnv, stateEnv+"="+base64.RawStdEncoding.EncodeToString(encoded), readyEnv+"=3", keeperDispatchEnv+"="+keeperDispatchValue, runEnv+"="+runID)
	cmd.ExtraFiles = []*os.File{writeReady, lifetimeRead}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	configureKeeper(cmd)
	if err := cmd.Start(); err != nil {
		return nil, errors.Join(fmt.Errorf("proc: start keeper: %w", err), readReady.Close(), writeReady.Close())
	}
	keeperWait := startProcessWait(cmd)
	if err := lifetimeRead.Close(); err != nil {
		lifetimeReaderClosed = true
		return nil, errors.Join(fmt.Errorf("proc: close launcher lifetime reader: %w", err), cleanupStartedKeeper(cmd, keeperWait, runID), readReady.Close())
	}
	lifetimeReaderClosed = true
	if err := writeReady.Close(); err != nil {
		return nil, errors.Join(fmt.Errorf("proc: close keeper handshake: %w", err), cleanupStartedKeeper(cmd, keeperWait, runID), readReady.Close())
	}
	readyCh := make(chan readyResult, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		rec, err := decodeReady(readReady)
		readyCh <- readyResult{record: rec, err: err}
	}()
	var ready record
	var readerResult *readyResult
	readReadyClosed := false
	for {
		switch outcome := selectStartupOutcome(ctx, readyCh, keeperWait.done); outcome.kind {
		case startupReady:
			result := outcome.result
			readerResult = &result
			readyCh = nil
			ready, err = result.record, result.err
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				// EOF is only a transport event. A live keeper may still produce
				// readiness through another writer; wait for process exit or ctx.
				readyCh = nil
				continue
			}
			if err != nil {
				select {
				case <-keeperWait.done:
					cleanupErr := cleanupStartedKeeper(cmd, keeperWait, runID)
					closeErr := readReady.Close()
					<-readerDone
					return nil, errors.Join(keeperExitError(keeperWait, result.err), cleanupErr, closeErr)
				default:
				}
				cleanupErr := cleanupStartedKeeper(cmd, keeperWait, runID)
				closeErr := readReady.Close()
				<-readerDone
				return nil, errors.Join(fmt.Errorf("proc: keeper startup failed: %w", err), closeErr, cleanupErr)
			}
			<-readerDone
			goto keeperReady
		case startupKeeperExited:
			// Expire and join the reader before tree cleanup: a writer outside the
			// discoverable tree must not make keeper-exit resolution wait for EOF.
			var result readyResult
			var closeErr error
			if readerResult != nil {
				result = *readerResult
				<-readerDone
				closeErr = readReady.Close()
				readReadyClosed = true
			} else {
				result, closeErr = resolveReadyAfterKeeperExit(readReady, readyCh, readerDone)
				readReadyClosed = true
			}
			treeErr := cleanupStartedKeeperTree(cmd.Process.Pid, runID)
			readyCh = nil
			if result.err == nil {
				if treeErr != nil || closeErr != nil {
					return nil, errors.Join(fmt.Errorf("proc: finish exited keeper startup: %w", errors.Join(treeErr, closeErr)))
				}
				ready, err = result.record, nil
				goto keeperReady
			}
			exitErr := keeperExitError(keeperWait, result.err)
			return nil, errors.Join(exitErr, treeErr, closeErr)
		case startupCanceled:
			if outcome.readyConsumed {
				// The selector consumed readiness before observing cancellation;
				// cleanup must join the reader without waiting for a second result.
				readyCh = nil
			}
			cleanupErr := cleanupStartedKeeper(cmd, keeperWait, runID)
			closeErr := readReady.Close()
			if readyCh != nil {
				<-readyCh
			}
			<-readerDone
			return nil, errors.Join(fmt.Errorf("proc: keeper startup canceled: %w", ctx.Err()), cleanupErr, closeErr)
		}
	}

keeperReady:
	if err != nil {
		cleanupErr := cleanupStartedKeeper(cmd, keeperWait, runID)
		return nil, errors.Join(fmt.Errorf("proc: keeper startup failed: %w", err), readReady.Close(), cleanupErr)
	}
	if !readReadyClosed {
		if err := readReady.Close(); err != nil {
			return nil, errors.Join(fmt.Errorf("proc: close keeper handshake reader: %w", err), cleanupStartedKeeper(cmd, keeperWait, runID))
		}
	}
	admissionPending = false
	run := &Run{PID: RecordedKeeperPID(cmd.Process.Pid), RunID: runID, StartedAt: ready.StartedAt, stateDir: cfg.StateDir, cmd: cmd, wait: keeperWait, lifetime: lifetimeWrite, record: ready, done: make(chan struct{}), leases: leases}
	lifetimeTransferred = true
	leaseOwnershipTransferred = true
	go func() {
		select {
		case <-ctx.Done():
			if err := run.Kill(); err != nil {
				log.Printf("proc: stop keeper after context cancellation: %v", err)
			}
			if err := run.Wait(); err != nil {
				log.Printf("proc: wait for canceled keeper: %v", err)
			}
		case <-run.done:
		}
	}()
	return run, nil
}

func validateCommandTempDir(path string) error {
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		return errors.New("proc: command temporary directory must be absolute")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("proc: inspect command temporary directory %q: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("proc: command temporary path %q is not a directory", path)
	}
	return nil
}

func keeperExitError(wait *processWait, handshakeErr error) *KeeperExitError {
	outcome := wait.outcome()
	if outcome.status == "" {
		outcome.status = "unknown exit status"
	}
	return &KeeperExitError{Status: outcome.status, Err: errors.Join(outcome.err, handshakeErr)}
}

func resolveReadyAfterKeeperExit(readReady *os.File, results <-chan readyResult, readerDone <-chan struct{}) (readyResult, error) {
	// Wait returning makes the descriptor terminal: expire reads immediately
	// so a surviving writer cannot hold startup open while the decoder joins.
	if err := readReady.SetReadDeadline(time.Now()); err != nil {
		closeErr := readReady.Close()
		result := <-results
		<-readerDone
		return result, errors.Join(fmt.Errorf("proc: expire keeper readiness read: %w", err), closeErr)
	}
	result := <-results
	<-readerDone
	return result, readReady.Close()
}

func cleanupStartedKeeper(cmd *exec.Cmd, wait *processWait, runID string) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	cleanupErr := cleanupStartedKeeperTree(cmd.Process.Pid, runID)
	identity, alive, identityErr := ProcessIdentity(cmd.Process.Pid)
	if identityErr != nil {
		cleanupErr = errors.Join(cleanupErr, fmt.Errorf("proc: inspect starting keeper before cleanup: %w", identityErr))
	} else if alive {
		if err := signalKeeper(RecordedKeeperPID(cmd.Process.Pid), identity, runID, syscall.SIGKILL, osProcessSource{}); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("proc: signal starting keeper through recorded keeper owner: %w", err))
		}
	}
	if wait != nil {
		// ErrProcessDone means the waiter already owns the terminal outcome.
		cleanupErr = errors.Join(cleanupErr, wait.outcome().err)
	}
	return cleanupErr
}

func cleanupStartedKeeperTree(pid int, runID string) error {
	parentIdentity, alive, identityErr := ProcessIdentity(os.Getpid())
	if identityErr != nil {
		return fmt.Errorf("proc: inspect startup caller before tree cleanup: %w", identityErr)
	}
	if !alive {
		return errors.New("proc: startup caller identity disappeared before tree cleanup")
	}
	cleanup := killTreeWithProtectedAncestors(pid, runID, nil, []ProcessIdentityEvidence{{PID: os.Getpid(), Identity: parentIdentity}})
	return errors.Join(cleanup.err, child.KillTree(pid))
}

func (r *Run) Wait() error {
	r.once.Do(func() {
		r.err = r.wait.outcome().err
		if r.err != nil {
			if lostErr := recordObservedKeeperLoss(r.stateDir, r.RunID, r.record); lostErr != nil {
				r.err = errors.Join(r.err, fmt.Errorf("proc: record keeper loss for run %s: %w", r.RunID, lostErr))
			}
		}
		if r.lifetime != nil {
			r.err = errors.Join(r.err, r.lifetime.Close())
			r.lifetime = nil
		}
		r.err = errors.Join(r.err, closeFileLeases(r.leases))
		close(r.done)
	})
	return r.err
}

// Kill asks the keeper to reap the descendants it can attribute before exiting.
func (r *Run) Kill() error {
	if r.cmd == nil || r.cmd.Process == nil {
		return errors.New("proc: run has no keeper process")
	}
	select {
	case <-r.done:
		return nil
	default:
	}
	return SignalRecordedKeeper(r.stateDir, r.RunID, syscall.SIGTERM)
}

// SignalRecordedKeeper sends a signal to the keeper named by the run record.
// It refuses to signal the calling process or any of its ancestors.
func SignalRecordedKeeper(stateDir, runID string, signal syscall.Signal) error {
	if signal != syscall.SIGTERM && signal != syscall.SIGKILL {
		return fmt.Errorf("proc: unsupported keeper signal %s", signal)
	}
	var rec record
	if err := withStateLock(stateDir, func() error {
		var err error
		rec, err = readRecordLocked(stateDir, runID)
		return err
	}); err != nil {
		return fmt.Errorf("proc: resolve keeper for run %s: %w", runID, err)
	}
	return signalKeeper(RecordedKeeperPID(rec.PID), rec.StartedAt, runID, signal, osProcessSource{})
}

// keeperMain runs the process selected by Start's private environment marker.
func keeperMain() diag.ExitStatus {
	encoded := os.Getenv(stateEnv)
	readyFD := os.Getenv(readyEnv)
	if encoded == "" || readyFD != "3" {
		fmt.Fprintln(os.Stderr, "proc: keeper must be started by proc.Start")
		return diag.ProcessExitStatus(2)
	}
	data, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		fmt.Fprintln(os.Stderr, "proc: invalid keeper configuration")
		return diag.ProcessExitStatus(2)
	}
	var cfg keeperConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		fmt.Fprintln(os.Stderr, "proc: invalid keeper configuration")
		return diag.ProcessExitStatus(2)
	}
	return diag.ProcessExitStatus(runKeeper(cfg))
}

// List reads run and queue records under their state lock, then verifies each PID identity.
func List(stateDir string) Listing {
	host := systemHostResourceSource().Snapshot()
	freeDisk, diskErr := freeDiskBytes(stateDir)
	if diskErr != nil {
		return Listing{Error: fmt.Errorf("proc: inspect free disk for governor: %w", diskErr)}
	}
	host.FreeDiskBytes, host.FreeDiskKnown = freeDisk, true
	hostResourceNoticeNow := hostResourceNotice(host)
	info, err := os.Stat(stateDir)
	if err != nil {
		return Listing{Error: fmt.Errorf("proc: inspect state directory: %w", err)}
	}
	if !info.IsDir() {
		return Listing{Error: fmt.Errorf("proc: state path %q is not a directory", stateDir)}
	}
	if err := validateEventStream(stateDir); err != nil {
		return Listing{Error: fmt.Errorf("proc: read event stream: %w", err)}
	}
	var records []record
	if err := withStateLock(stateDir, func() error {
		if err := pruneStateLocked(stateDir); err != nil {
			return err
		}
		var readErr error
		records, readErr = readAllRecordsLocked(stateDir)
		return readErr
	}); err != nil {
		return Listing{Error: fmt.Errorf("proc: read run registry: %w", err)}
	}
	gov, govErr := readGovernorState(stateDir)
	if govErr != nil {
		return Listing{Error: fmt.Errorf("proc: read governor state: %w", govErr)}
	}
	out := Listing{Runs: make([]RunInfo, 0, len(records)), Host: host, GovernorDecision: gov.Decision, GovernorReason: gov.Reason}
	if out.GovernorDecision == "" {
		out.GovernorDecision = "normal"
	}
	now := time.Now()
	for _, rec := range records {
		status := rec.Status
		identity, live, identityErr := inspectIdentity(rec.PID)
		if identityErr != nil {
			return Listing{Error: fmt.Errorf("proc: inspect keeper %d: %w", rec.PID, identityErr)}
		}
		if rec.Status == StatusQueued || rec.Status == StatusBlocked || rec.Status == StatusStarting {
			if !live || identity != rec.StartedAt {
				continue
			}
			if status == StatusStarting {
				status = StatusQueued
			}
		} else if rec.Status.Terminal() {
			status = rec.Status
		} else if live && identity == rec.StartedAt {
			status = StatusRunning
			if rec.Status == StatusPaused {
				status = StatusPaused
			}
			if status != StatusPaused && rec.StallMS > 0 && !rec.LastOutputAt.IsZero() && now.Sub(rec.LastOutputAt) >= time.Duration(rec.StallMS)*time.Millisecond {
				status = StatusStalled
			}
		} else {
			status = StatusDead
		}
		elapsed := rec.DurationMS
		if status == StatusQueued || status == StatusBlocked {
			if !rec.EnqueuedAt.IsZero() {
				elapsed = now.Sub(rec.EnqueuedAt).Milliseconds()
			}
		} else if !status.Terminal() && !rec.StartedAtTime.IsZero() {
			pausedMS := rec.PausedMS
			if status == StatusPaused && !rec.PausedAt.IsZero() {
				pausedMS += now.Sub(rec.PausedAt).Milliseconds()
			}
			elapsed = now.Sub(rec.StartedAtTime).Milliseconds() - pausedMS
		}
		position := 0
		if status == StatusQueued || status == StatusBlocked {
			position = queuePosition(rec, records)
		}
		info := RunInfo{
			RunID: rec.RunID, Tag: rec.Tag, PID: RecordedKeeperPID(rec.PID), StartedAt: runStartedAt(rec), Identity: rec.StartedAt,
			Status: status, Command: rec.Command, SlotGroup: rec.SlotGroup, SlotWeight: rec.SlotWeight,
			QueuePosition: position, WaitReason: rec.WaitReason, ElapsedMS: elapsed, StallMS: rec.StallMS,
			ExitCode: rec.ExitCode, Signal: rec.Signal, DurationMS: rec.DurationMS,
			Error: rec.Error, CostKey: rec.CostKey, CostClass: rec.CostClass, Priority: rec.Priority, MemoryBytes: rec.MemoryBytes, CPUsMin: rec.CPUsMin, CPUsMax: rec.CPUsMax,
			DiskBytes: rec.DiskBytes, GrantedCPUs: rec.GrantedCPUs, PeakRSSBytes: rec.PeakRSSBytes, AverageCPU: rec.AverageCPU,
			MeasurementPartial: rec.MeasurementPartial, LimitsAdvisory: rec.LimitsAdvisory, OverBudget: rec.OverBudget, ResourceNotice: hostResourceNoticeNow,
			Paused: status == StatusPaused, PausedMS: rec.PausedMS, ResourceOutcomes: rec.Resources,
		}
		if status == StatusPaused {
			info.WaitReason = gov.Reason
		}
		if live && identity == rec.StartedAt && status != StatusQueued && status != StatusBlocked {
			tree, treeErr := processTreeWithKnownAncestors(osProcessSource{}, rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors)
			info.Tree = tree
			if treeErr != nil {
				observationErr := fmt.Errorf("unverified/failed observation: %w", treeErr)
				if info.Error == "" {
					info.Error = observationErr.Error()
				} else {
					info.Error = errors.Join(errors.New(info.Error), observationErr).Error()
				}
			}
		}
		out.Runs = append(out.Runs, info)
	}
	return out
}

func queuePosition(candidate record, records []record) int {
	position := 1
	for _, rec := range records {
		if rec.SlotGroup == candidate.SlotGroup && rec.QueueOrder < candidate.QueueOrder &&
			(rec.Status == StatusQueued || rec.Status == StatusBlocked) {
			position++
		}
	}
	return position
}

func ProcessTree(root int, runID string) ([]Process, error) {
	return processTreeWithSource(osProcessSource{}, root, runID)
}

func processTreeWithSource(source processSource, root int, runID string) ([]Process, error) {
	all, err := source.Snapshot(runID)
	return processTreeFromSnapshot(all, root), wrapSnapshotError(err)
}

func wrapSnapshotError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("process table snapshot: %w", err)
}

func processTreeFromSnapshot(all []Process, root int) []Process {
	tree, _ := processTreeFromSnapshotWithMembership(all, root)
	return tree
}

func processTreeFromSnapshotWithMembership(all []Process, root int) ([]Process, map[string]string) {
	children := make(map[int][]int)
	byPID := make(map[int]Process, len(all))
	for _, process := range all {
		children[process.PPID] = append(children[process.PPID], process.PID)
		byPID[process.PID] = process
	}
	ancestry := map[int]bool{root: true}
	queue := []int{root}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		for _, child := range children[pid] {
			if process, exists := byPID[child]; exists && processBelongsToAnotherRun(process) {
				continue
			}
			if !ancestry[child] {
				ancestry[child] = true
				queue = append(queue, child)
			}
		}
	}
	membership := make(map[string]string)
	for _, process := range all {
		key := processObservationKey(process)
		switch {
		case process.PID == root:
			membership[key] = "root:keeper-run-owner"
		case processBelongsToAnotherRun(process):
			membership[key] = "rejected:other-run-marker"
		case process.runToken:
			membership[key] = "accepted:run-token-fd"
		case process.runMarker:
			membership[key] = "accepted:run-marker"
		case process.PID != root && ancestry[process.PID]:
			membership[key] = "accepted:parent-ancestry"
		case process.markerResult == "unreadable":
			membership[key] = "rejected:marker-unreadable-without-parent-history"
		default:
			membership[key] = "rejected:no-run-marker-or-parent-history"
		}
	}
	for _, process := range all {
		if !processBelongsToAnotherRun(process) && (process.runMarker || process.runToken) {
			ancestry[process.PID] = true
		}
	}
	out := make([]Process, 0, len(membership))
	for pid := range ancestry {
		if pid == root {
			continue
		}
		if process, ok := byPID[pid]; ok {
			process.Unverified = false
			out = append(out, process)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out, membership
}

func processDescendantsFromSnapshot(snapshot []Process, root int) []Process {
	children := make(map[int][]int, len(snapshot))
	byPID := make(map[int]Process, len(snapshot))
	for _, process := range snapshot {
		children[process.PPID] = append(children[process.PPID], process.PID)
		byPID[process.PID] = process
	}
	seen := map[int]bool{root: true}
	queue := []int{root}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent] {
			if !seen[child] {
				process := byPID[child]
				if process.processState == "Z" || process.processState == "X" || processBelongsToAnotherRun(process) {
					continue
				}
				seen[child] = true
				queue = append(queue, child)
			}
		}
	}
	descendants := make([]Process, 0, len(seen)-1)
	for pid := range seen {
		if pid != root {
			descendants = append(descendants, byPID[pid])
		}
	}
	sort.Slice(descendants, func(i, j int) bool { return descendants[i].PID < descendants[j].PID })
	return descendants
}

func processBelongsToAnotherRun(process Process) bool {
	return process.markerResult == "other-run" && !process.runMarker
}

func ProcessTreeWithHistory(root int, runID string, observed []Process) ([]Process, error) {
	return processTreeWithHistorySource(osProcessSource{}, root, runID, observed)
}

func processTreeWithHistorySource(source processSource, root int, runID string, observed []Process) ([]Process, error) {
	return processTreeWithKnownAncestors(source, root, runID, observed, nil)
}

func processTreeWithKnownAncestors(source processSource, root int, runID string, observed []Process, knownAncestors []ProcessIdentityEvidence) ([]Process, error) {
	snapshot, err := source.Snapshot(runID)
	tree, _, historyErr := processTreeWithHistorySnapshot(source, root, observed, snapshot, knownAncestors)
	return tree, errors.Join(wrapSnapshotError(err), historyErr)
}

func processTreeWithHistorySnapshot(source processSource, root int, observed, snapshot []Process, knownAncestors ...[]ProcessIdentityEvidence) ([]Process, map[string]string, error) {
	tree, membership := processTreeFromSnapshotWithMembership(snapshot, root)
	protected := keeperAncestry(root, snapshot)
	for _, ancestors := range knownAncestors {
		for _, process := range ancestors {
			key := processObservationKey(Process{PID: process.PID, Identity: process.Identity})
			protected[key] = "protected:recorded-supervisor-ancestor"
		}
	}
	filteredTree := tree[:0]
	for _, process := range tree {
		if _, isProtected := protected[processObservationKey(process)]; isProtected {
			membership[processObservationKey(process)] = "rejected:keeper-ancestor"
			continue
		}
		filteredTree = append(filteredTree, process)
	}
	tree = filteredTree
	var snapshotErr error
	byPID := make(map[int]Process)
	for _, process := range tree {
		byPID[process.PID] = process
	}
	currentProcesses := make(map[int]Process)
	for _, process := range snapshot {
		currentProcesses[process.PID] = process
	}
	for _, previous := range observed {
		key := processObservationKey(previous)
		identity, alive, err := source.Identity(previous.PID)
		if err != nil {
			if processGone(err) {
				membership[key] = "rejected:recorded-process-gone"
				continue
			}
			previous.Unverified = true
			byPID[previous.PID] = previous
			membership[key] = "accepted:recorded-pid-start-identity-unverified"
			snapshotErr = errors.Join(snapshotErr, fmt.Errorf("inspect observed process %d: %w", previous.PID, err))
			continue
		}
		if !alive {
			membership[key] = "rejected:recorded-process-gone"
			continue
		}
		if identity != previous.Identity {
			membership[key] = "rejected:recorded-start-identity-mismatch"
			continue
		}
		current, ok := currentProcesses[previous.PID]
		if ok && current.Identity != previous.Identity {
			membership[key] = "rejected:inventory-start-identity-mismatch"
			continue
		}
		if ok && processBelongsToAnotherRun(current) {
			membership[key] = "rejected:other-run-marker"
			continue
		}
		if !ok {
			current = previous
		}
		current.Unverified = false
		if previous.runToken && !current.runToken && current.tokenResult == "absent" && current.markerResult != "match" {
			current.OwnershipUnverifiedReason = OwnershipUnverifiedRunTokenClosed
		}
		byPID[current.PID] = current
		membership[processObservationKey(current)] = "accepted:recorded-pid-start-identity"
	}
	for pid, process := range byPID {
		if _, isProtected := protected[processObservationKey(process)]; isProtected {
			delete(byPID, pid)
			membership[processObservationKey(process)] = "rejected:keeper-ancestor"
		}
	}
	out := make([]Process, 0, len(byPID))
	for _, process := range byPID {
		out = append(out, process)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out, membership, snapshotErr
}

func processIdentityEvidence(process Process) ProcessIdentityEvidence {
	return ProcessIdentityEvidence{PID: process.PID, PPID: process.PPID, PGID: process.processGroupID, SID: process.sessionID, UID: process.uid, Identity: process.Identity}
}

func processTreeInventorySample(index int, processes, observed []Process, targets map[string]Process, membership map[string]string, snapshotErr error) ProcessTreeInventorySample {
	sample := ProcessTreeInventorySample{Index: index, Processes: make([]ProcessTreeInventoryEvidence, 0)}
	if snapshotErr != nil {
		sample.SnapshotErr = snapshotErr.Error()
	}
	seen := make(map[string]bool, len(processes)+len(observed)+len(targets))
	currentIncluded := make(map[string]bool)
	importanceByKey := make(map[string]int)
	rejectedCounts := make(map[string]ProcessTreeInventoryRejectedCount)
	var rejectedExamples []ProcessTreeInventoryEvidence
	currentUID := uint32(os.Getuid())
	appendEvidence := func(process Process, reason, markerResult string) ProcessTreeInventoryEvidence {
		return ProcessTreeInventoryEvidence{
			PID: process.PID, PPID: process.PPID, PGID: process.processGroupID, SID: process.sessionID,
			SIDError: process.sessionIDError, UID: process.uid, Identity: process.Identity,
			MarkerResult: markerResult, MarkerError: process.markerReadError,
			TokenResult: process.tokenResult, TokenError: process.tokenReadError,
			OwnershipUnverifiedReason: process.OwnershipUnverifiedReason, Membership: reason,
		}
	}
	appendProcess := func(process Process, missing bool) {
		reason := membership[processObservationKey(process)]
		key := processObservationKey(process)
		_, isTarget := targets[key]
		if reason == "" {
			reason = "accepted:cleanup-target"
		}
		markerResult := process.markerResult
		if missing {
			markerResult = "not-in-current-inventory"
		}
		full := reason == "root:keeper-run-owner" || strings.HasPrefix(reason, "accepted:") || isTarget
		if !full {
			if strings.HasPrefix(reason, "rejected:") {
				uidClass := "foreign"
				if process.uid == currentUID {
					uidClass = "same"
				}
				countKey := reason + "\x00" + markerResult + "\x00" + process.tokenResult + "\x00" + uidClass
				count := rejectedCounts[countKey]
				count.Membership, count.MarkerResult, count.TokenResult, count.UIDClass = reason, markerResult, process.tokenResult, uidClass
				count.PotentialSetuidOwner = uidClass == "foreign" && markerResult == "unreadable"
				count.Count++
				rejectedCounts[countKey] = count
				rejectedExamples = append(rejectedExamples, appendEvidence(process, reason, markerResult))
			}
			return
		}
		sample.Processes = append(sample.Processes, appendEvidence(process, reason, markerResult))
		importance := 2
		if reason == "root:keeper-run-owner" {
			importance = 0
		} else if isTarget {
			importance = 1
		}
		importanceByKey[key] = importance
		seen[key] = true
		if !missing {
			currentIncluded[key] = true
		}
	}
	for _, process := range processes {
		appendProcess(process, false)
	}
	for _, process := range observed {
		key := processObservationKey(process)
		if !seen[key] {
			if _, target := targets[key]; target {
				appendProcess(process, true)
			}
		}
	}
	for _, process := range targets {
		key := processObservationKey(process)
		if !seen[key] {
			appendProcess(process, true)
		}
	}
	sort.Slice(sample.Processes, func(i, j int) bool { return sample.Processes[i].PID < sample.Processes[j].PID })
	sort.SliceStable(sample.Processes, func(i, j int) bool {
		left := processEvidenceKey(sample.Processes[i])
		right := processEvidenceKey(sample.Processes[j])
		if importanceByKey[left] != importanceByKey[right] {
			return importanceByKey[left] < importanceByKey[right]
		}
		return sample.Processes[i].PID < sample.Processes[j].PID
	})
	includedOmitted := len(sample.Processes) - maxTeardownProcessesPerSample
	if includedOmitted > 0 {
		sample.Processes = sample.Processes[:maxTeardownProcessesPerSample]
	} else {
		includedOmitted = 0
	}
	for _, count := range rejectedCounts {
		sample.RejectedCounts = append(sample.RejectedCounts, count)
	}
	sort.Slice(sample.RejectedCounts, func(i, j int) bool {
		if sample.RejectedCounts[i].Membership != sample.RejectedCounts[j].Membership {
			return sample.RejectedCounts[i].Membership < sample.RejectedCounts[j].Membership
		}
		if sample.RejectedCounts[i].MarkerResult != sample.RejectedCounts[j].MarkerResult {
			return sample.RejectedCounts[i].MarkerResult < sample.RejectedCounts[j].MarkerResult
		}
		if sample.RejectedCounts[i].TokenResult != sample.RejectedCounts[j].TokenResult {
			return sample.RejectedCounts[i].TokenResult < sample.RejectedCounts[j].TokenResult
		}
		return sample.RejectedCounts[i].UIDClass < sample.RejectedCounts[j].UIDClass
	})
	sort.Slice(rejectedExamples, func(i, j int) bool {
		priority := func(process ProcessTreeInventoryEvidence) int {
			if process.MarkerResult != "unreadable" {
				return 2
			}
			if process.UID == uint32(os.Getuid()) {
				return 0
			}
			return 1
		}
		left, right := priority(rejectedExamples[i]), priority(rejectedExamples[j])
		if left != right {
			return left < right
		}
		return rejectedExamples[i].PID < rejectedExamples[j].PID
	})
	if len(rejectedExamples) > maxTeardownRejectedExamples {
		rejectedExamples = rejectedExamples[:maxTeardownRejectedExamples]
	}
	sample.RejectedExamples = rejectedExamples
	sample.OmittedProcesses = len(processes) - len(currentIncluded) + includedOmitted
	return sample
}

func processEvidenceKey(process ProcessTreeInventoryEvidence) string {
	return processObservationKey(Process{PID: process.PID, Identity: process.Identity})
}

func appendTeardownInventorySample(samples []ProcessTreeInventorySample, sample ProcessTreeInventorySample) []ProcessTreeInventorySample {
	if len(samples) == 0 {
		return append(samples, sample)
	}
	sample.MembershipChanged = inventoryMembershipKey(samples[len(samples)-1]) != inventoryMembershipKey(sample)
	if len(samples) < maxTeardownInventorySamples {
		return append(samples, sample)
	}
	all := append(append([]ProcessTreeInventorySample(nil), samples...), sample)
	first := all[0]
	last := all[len(all)-1]
	transitions := make([]ProcessTreeInventorySample, 0, len(all)-2)
	for _, candidate := range all[1 : len(all)-1] {
		if candidate.MembershipChanged {
			transitions = append(transitions, candidate)
		}
	}
	transitionLimit := maxTeardownInventorySamples - 2
	if len(transitions) > transitionLimit {
		transitions = transitions[len(transitions)-transitionLimit:]
	}
	retained := make([]ProcessTreeInventorySample, 0, maxTeardownInventorySamples)
	retained = append(retained, first)
	retained = append(retained, transitions...)
	retained = append(retained, last)
	return retained
}

func (cleanup *treeCleanup) appendInventory(sample ProcessTreeInventorySample) {
	if len(cleanup.Inventory) >= maxTeardownInventorySamples {
		cleanup.InventorySamplesOmitted++
	}
	cleanup.Inventory = appendTeardownInventorySample(cleanup.Inventory, sample)
}

func inventoryMembershipKey(sample ProcessTreeInventorySample) string {
	var builder strings.Builder
	for _, process := range sample.Processes {
		builder.WriteString(strconv.Itoa(process.PID))
		builder.WriteByte(':')
		builder.WriteString(process.Identity)
		builder.WriteByte(':')
		builder.WriteString(process.Membership)
		builder.WriteByte(';')
	}
	return builder.String()
}

func ProcessLeaves(root int, runID string) ([]Process, error) {
	processes, err := ProcessTree(root, runID)
	return processLeaves(processes), err
}

func ProcessLeavesWithHistory(root int, runID string, observed []Process) ([]Process, error) {
	processes, err := ProcessTreeWithHistory(root, runID, observed)
	return processLeaves(processes), err
}

func processLeaves(processes []Process) []Process {
	parents := make(map[int]bool, len(processes))
	for _, process := range processes {
		parents[process.PPID] = true
	}
	leaves := make([]Process, 0, len(processes))
	for _, process := range processes {
		if !parents[process.PID] {
			leaves = append(leaves, process)
		}
	}
	return leaves
}

func cleanupTreeWithSource(root int, runID string, observed []Process, source processSource) treeCleanup {
	return cleanupTreeWithClock(root, runID, observed, source, wallCleanupClock{})
}

func cleanupTreeWithProtectedSource(root int, runID string, observed []Process, protected []ProcessIdentityEvidence, source processSource) treeCleanup {
	return cleanupTreeWithProtectedClock(root, runID, observed, protected, source, wallCleanupClock{})
}

func cleanupTreeWithProtectedSourceAndDirectChild(root int, runID string, observed []Process, protected []ProcessIdentityEvidence, source processSource, directChild *os.Process) treeCleanup {
	return cleanupTreeWithProtectedClockAndDirectChild(root, runID, observed, protected, source, wallCleanupClock{}, directChild)
}

const (
	cleanupBound = 3 * time.Second
	cleanupPoll  = 20 * time.Millisecond
	termGrace    = 250 * time.Millisecond
)

func cleanupTreeWithClock(root int, runID string, observed []Process, source processSource, clock cleanupClock) treeCleanup {
	return cleanupTreeWithProtectedClock(root, runID, observed, nil, source, clock)
}

func cleanupTreeWithProtectedClock(root int, runID string, observed []Process, protectedAncestors []ProcessIdentityEvidence, source processSource, clock cleanupClock) treeCleanup {
	return cleanupTreeWithProtectedClockAndDirectChild(root, runID, observed, protectedAncestors, source, clock, nil)
}

func cleanupTreeWithProtectedClockAndDirectChild(root int, runID string, observed []Process, protectedAncestors []ProcessIdentityEvidence, source processSource, clock cleanupClock, directChild *os.Process) treeCleanup {
	result := treeCleanup{Reaped: make([]Process, 0), Unverified: make([]Process, 0), Remaining: make([]Process, 0), History: make([]ProcessIdentityEvidence, 0, len(observed)), Inventory: make([]ProcessTreeInventorySample, 0)}
	for _, process := range observed {
		result.History = append(result.History, processIdentityEvidence(process))
	}
	var failures []error
	seenFailures := make(map[string]bool)
	recordFailure := func(err error) {
		if err != nil && !seenFailures[err.Error()] {
			seenFailures[err.Error()] = true
			failures = append(failures, err)
		}
	}
	deadline := clock.Now().Add(cleanupBound)
	containedSource, supportsContainment := source.(containedProcessSource)
	targets := make(map[string]Process, len(observed))
	if !supportsContainment {
		for _, process := range observed {
			targets[processObservationKey(process)] = process
		}
	}
	observedTree := append([]Process(nil), observed...)
	termSent := make(map[string]time.Time)
	killSent := make(map[string]bool)
	emptySnapshots := 0
	var lastSnapshotErr error
	snapshotFailureRecorded := false
	inventoryIndex := 0
	containmentOwnerSeen := false
	for clock.Now().Before(deadline) {
		inventoryIndex++
		snapshot, inventoryErr := source.Snapshot(runID)
		protected := keeperAncestry(root, snapshot)
		var tree []Process
		var membership map[string]string
		var historyErr error
		if supportsContainment {
			contained, ownerPresent, containmentErr := containedSource.ContainedDescendants(root, snapshot)
			if ownerPresent {
				if !containmentOwnerSeen {
					targets = make(map[string]Process)
				}
				containmentOwnerSeen = true
				tree = contained
				membership = make(map[string]string, len(contained))
				for _, process := range contained {
					membership[processObservationKey(process)] = "accepted:keeper-subreaper-descendant"
				}
				historyErr = nil
				if containmentErr != nil {
					historyErr = containmentErr
				}
			} else {
				tree, membership, historyErr = processTreeWithHistorySnapshot(source, root, observedTree, snapshot, protectedAncestors)
				if !containmentOwnerSeen {
					for _, process := range observed {
						targets[processObservationKey(process)] = process
					}
				} else if containmentErr == nil {
					containmentErr = errors.New("Linux subreaper owner disappeared during process-tree cleanup")
				}
				historyErr = errors.Join(historyErr, containmentErr)
			}
		} else {
			tree, membership, historyErr = processTreeWithHistorySnapshot(source, root, observedTree, snapshot, protectedAncestors)
		}
		for _, process := range protectedAncestors {
			key := processObservationKey(Process{PID: process.PID, Identity: process.Identity})
			protected[key] = "protected:recorded-supervisor-ancestor"
		}
		snapshotErr := errors.Join(wrapSnapshotError(inventoryErr), historyErr)
		sample := processTreeInventorySample(inventoryIndex, snapshot, observedTree, targets, membership, snapshotErr)
		result.appendInventory(sample)
		if snapshotErr != nil {
			if !snapshotFailureRecorded {
				recordFailure(fmt.Errorf("unverified/failed observation: %w", snapshotErr))
				snapshotFailureRecorded = true
			}
			lastSnapshotErr = snapshotErr
		} else {
			lastSnapshotErr = nil
		}
		if snapshotErr != nil && len(tree) == 0 && len(targets) == 0 {
			break
		}
		if len(tree) == 0 && snapshotErr == nil {
			emptySnapshots++
		} else {
			emptySnapshots = 0
		}
		for _, process := range tree {
			key := processObservationKey(process)
			targets[key] = process
			if !process.Unverified && !containsProcess(observedTree, process) {
				observedTree = append(observedTree, process)
				result.History = append(result.History, processIdentityEvidence(process))
			}
		}
		if !clock.Now().Before(deadline) {
			break
		}
		allGone := true
		verifiedLive := false
		unverifiedFound := false
		deadlineReached := false
		for key, process := range targets {
			if reason, isProtected := protected[key]; isProtected {
				fmt.Fprintf(os.Stderr, "proc: teardown skipped signal pid=%d identity=%q reason=%s\n", process.PID, process.Identity, reason)
				delete(targets, key)
				continue
			}
			if process.Unverified {
				allGone = false
				unverifiedFound = true
				continue
			}
			identity, alive, identityErr := source.Identity(process.PID)
			if identityErr != nil {
				allGone = false
				unverifiedFound = true
				recordFailure(fmt.Errorf("observe process %d during teardown: %w", process.PID, identityErr))
				process.Unverified = true
				targets[key] = process
				continue
			}
			if !alive || identity != process.Identity {
				continue
			}
			allGone = false
			verifiedLive = true
			if !clock.Now().Before(deadline) {
				deadlineReached = true
				break
			}
			if firstSignal, signaled := termSent[key]; !signaled {
				reason := membership[key]
				if reason == "" {
					reason = "accepted:recorded-pid-start-identity"
				}
				fmt.Fprintf(os.Stderr, "proc: teardown signal pid=%d identity=%q signal=SIGTERM attribution=%s\n", process.PID, process.Identity, reason)
				if signalErr := signalCleanupTarget(source, directChild, process, syscall.SIGTERM); signalErr != nil && !errors.Is(signalErr, syscall.ESRCH) {
					recordFailure(fmt.Errorf("send SIGTERM to process %d: %w", process.PID, signalErr))
				}
				termSent[key] = clock.Now()
			} else if clock.Now().Sub(firstSignal) >= termGrace && !killSent[key] {
				reason := membership[key]
				if reason == "" {
					reason = "accepted:recorded-pid-start-identity"
				}
				fmt.Fprintf(os.Stderr, "proc: teardown signal pid=%d identity=%q signal=SIGKILL attribution=%s\n", process.PID, process.Identity, reason)
				if signalErr := signalCleanupTarget(source, directChild, process, syscall.SIGKILL); signalErr != nil && !errors.Is(signalErr, syscall.ESRCH) {
					recordFailure(fmt.Errorf("send SIGKILL to process %d: %w", process.PID, signalErr))
				}
				killSent[key] = true
			}
		}
		if deadlineReached || !clock.Now().Before(deadline) {
			break
		}
		if canFinishTreeCleanup(allGone, emptySnapshots, lastSnapshotErr) {
			break
		}
		if unverifiedFound && !verifiedLive {
			break
		}
		clock.Wait(cleanupPoll)
	}
	// The deadline bounds discovery and polling. Give already-attributed targets
	// one final identity check and escalation; never discover or signal new PIDs here.
	for key := range termSent {
		if killSent[key] {
			continue
		}
		process, exists := targets[key]
		if !exists || process.Unverified {
			continue
		}
		identity, alive, identityErr := source.Identity(process.PID)
		if identityErr != nil {
			recordFailure(fmt.Errorf("verify process %d before final SIGKILL: %w", process.PID, identityErr))
			continue
		}
		if !alive || identity != process.Identity {
			continue
		}
		fmt.Fprintf(os.Stderr, "proc: teardown signal pid=%d identity=%q signal=SIGKILL attribution=accepted:recorded-pid-start-identity\n", process.PID, process.Identity)
		if signalErr := signalCleanupTarget(source, directChild, process, syscall.SIGKILL); signalErr != nil && !errors.Is(signalErr, syscall.ESRCH) {
			recordFailure(fmt.Errorf("send final SIGKILL to process %d: %w", process.PID, signalErr))
		}
		killSent[key] = true
	}
	for _, process := range targets {
		if process.Unverified {
			result.Unverified = append(result.Unverified, process)
			result.Remaining = append(result.Remaining, process)
			recordFailure(fmt.Errorf("unverified process %d prevents verified tree cleanup", process.PID))
			continue
		}
		identity, alive, identityErr := source.Identity(process.PID)
		if identityErr != nil {
			recordFailure(fmt.Errorf("verify process %d after teardown: %w", process.PID, identityErr))
			process.Unverified = true
			result.Remaining = append(result.Remaining, process)
			continue
		}
		if alive && identity == process.Identity {
			result.Remaining = append(result.Remaining, process)
		} else {
			result.Reaped = append(result.Reaped, process)
		}
	}
	if len(result.Remaining) > 0 && !clock.Now().Before(deadline) {
		if containmentOwnerSeen {
			survivors := make([]string, 0, len(result.Remaining))
			for _, process := range result.Remaining {
				state := process.processState
				if state == "" {
					state = "unknown"
				}
				survivors = append(survivors, fmt.Sprintf("pid=%d state=%s ppid=%d pgid=%d sid=%d identity=%q", process.PID, state, process.PPID, process.processGroupID, process.sessionID, process.Identity))
			}
			recordFailure(fmt.Errorf("Linux subreaper cleanup deadline expired with survivors: %s", strings.Join(survivors, "; ")))
		} else {
			recordFailure(errors.New("tree cleanup deadline expired with owned processes remaining"))
		}
	}
	result.err = errors.Join(failures...)
	return result
}

func keeperAncestry(root int, snapshot []Process) map[string]string {
	byPID := make(map[int]Process, len(snapshot))
	for _, process := range snapshot {
		byPID[process.PID] = process
	}
	protected := make(map[string]string)
	seen := make(map[int]bool)
	for pid, reason := root, "protected:keeper"; pid > 0 && !seen[pid]; {
		seen[pid] = true
		process, exists := byPID[pid]
		if !exists {
			break
		}
		protected[processObservationKey(process)] = reason
		pid, reason = process.PPID, "protected:keeper-ancestor"
	}
	return protected
}

func canFinishTreeCleanup(allGone bool, emptySnapshots int, snapshotErr error) bool {
	return allGone && emptySnapshots >= 2 && snapshotErr == nil
}

func containsProcess(processes []Process, candidate Process) bool {
	for _, process := range processes {
		if processObservationKey(process) == processObservationKey(candidate) {
			return true
		}
	}
	return false
}

func sortedProcesses(processes map[int]Process) []Process {
	out := make([]Process, 0, len(processes))
	for _, process := range processes {
		out = append(out, process)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out
}

func newID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", raw), nil
}

func filteredEnv(env []string) []string {
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if strings.HasPrefix(item, stateEnv+"=") || strings.HasPrefix(item, readyEnv+"=") || strings.HasPrefix(item, keeperDispatchEnv+"=") || strings.HasPrefix(item, runEnv+"=") || strings.HasPrefix(item, resourceStateEnv+"=") || strings.HasPrefix(item, "KB_RUNNER_CPUS=") || strings.HasPrefix(item, "KB_RUNNER_MEM_BYTES=") {
			continue
		}
		out = append(out, item)
	}
	return out
}

func environmentFor(cfg Config, parent []string) []string {
	var env []string
	if cfg.CleanEnv {
		env = make([]string, 0, len(cfg.Env))
	} else {
		env = filteredEnv(parent)
	}
	for _, item := range cfg.Env {
		if strings.HasPrefix(item, keeperDispatchEnv+"=") {
			continue
		}
		env = append(env, item)
	}
	return env
}

func decodeReady(r *os.File) (record, error) {
	data := make([]byte, 0, 512)
	chunk := make([]byte, 4096)
	for {
		n, readErr := r.Read(chunk)
		if n > 0 {
			data = append(data, chunk[:n]...)
		}
		if readErr != nil {
			if errors.Is(readErr, os.ErrDeadlineExceeded) {
				var drainErr error
				data, drainErr = drainReadyPipe(r, data)
				if drainErr != nil {
					return record{}, errors.Join(fmt.Errorf("proc: drain expired readiness pipe: %w", drainErr), io.ErrUnexpectedEOF)
				}
			}
			line := data
			if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
				line = data[:newline]
			}
			if len(line) == 0 && errors.Is(readErr, io.EOF) {
				return record{}, io.EOF
			}
			if bytes.IndexByte(data, '\n') < 0 {
				return record{}, errors.Join(io.ErrUnexpectedEOF, readErr)
			}
			return decodeReadyLine(line)
		}
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			return decodeReadyLine(data[:newline])
		}
	}
}

func decodeReadyLine(data []byte) (record, error) {
	var ready readyMessage
	if err := json.Unmarshal(data, &ready); err != nil {
		return record{}, err
	}
	if ready.Error != "" {
		return record{}, errors.New(ready.Error)
	}
	if ready.Record.StartedAt == "" {
		return record{}, errors.New("keeper returned no process identity")
	}
	return ready.Record, nil
}

func drainReadyPipe(r *os.File, data []byte) ([]byte, error) {
	fd := int(r.Fd())
	if err := syscall.SetNonblock(fd, true); err != nil {
		return data, err
	}
	chunk := make([]byte, 4096)
	for {
		n, err := syscall.Read(fd, chunk)
		if n > 0 {
			data = append(data, chunk[:n]...)
		}
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) || (err == nil && n == 0) {
			return data, nil
		}
		if err != nil {
			return data, err
		}
	}
}

func writeRecord(rec record) error {
	return withStateLock(rec.StateDir, func() error {
		queued, err := readRecordLocked(rec.StateDir, rec.RunID)
		if err == nil {
			rec.SlotGroup, rec.Slots, rec.QueueOrder = queued.SlotGroup, queued.Slots, queued.QueueOrder
			rec.EnqueuedAt, rec.WaitGate, rec.HoldGate = queued.EnqueuedAt, queued.WaitGate, queued.HoldGate
			rec.CostKey, rec.CostClass, rec.MemoryBytes, rec.CPUsMin, rec.CPUsMax, rec.DiskBytes = queued.CostKey, queued.CostClass, queued.MemoryBytes, queued.CPUsMin, queued.CPUsMax, queued.DiskBytes
			rec.GrantedCPUs, rec.ResourceNotice = queued.GrantedCPUs, queued.ResourceNotice
		} else if !os.IsNotExist(err) {
			return err
		}
		if rec.Status == "" {
			rec.Status = StatusStarting
		}
		return writeRecordAtomic(rec)
	})
}

func eventFor(rec record, kind EventType) Event {
	return Event{Schema: EventSchema, At: time.Now().UTC(), Type: kind, Status: rec.Status, RunID: rec.RunID, Tag: rec.Tag, KeeperPID: rec.PID, Command: commandText(rec.Command), CostClass: rec.CostClass, GovernorDecision: "normal", MemoryBytes: rec.MemoryBytes, CPUsMin: rec.CPUsMin, CPUsMax: rec.CPUsMax, DiskBytes: rec.DiskBytes, GrantedCPUs: rec.GrantedCPUs, PeakRSSBytes: rec.PeakRSSBytes, AverageCPU: rec.AverageCPU, MeasurementPartial: rec.MeasurementPartial, LimitsAdvisory: rec.LimitsAdvisory, OverBudget: rec.OverBudget, ResourceNotice: rec.ResourceNotice}
}

func exitStatus(code *int, signal, failure string) RunStatus {
	if failure != "" {
		return StatusFailed
	}
	if signal != "" {
		return StatusDead
	}
	if code == nil || *code != 0 {
		return StatusFailed
	}
	return StatusCompleted
}

func runStartedAt(rec record) *time.Time {
	if rec.StartedAtTime.IsZero() {
		return nil
	}
	value := rec.StartedAtTime.UTC()
	return &value
}

func commandText(command []string) string { return strings.Join(command, " ") }

// configureCommand is the single owner of the supervisor-controlled command
// environment: run identity, resource state, scratch, temp dirs, and the
// resource grant are set together after one filtering pass.
func configureCommand(cmd *exec.Cmd, cfg Config, runID, stateDir, scratch string) error {
	commandTempDir := cfg.CommandTempDir
	if commandTempDir == "" {
		commandTempDir = scratch
	}
	cmd.Env = append(filteredEnv(cmd.Env), runEnv+"="+runID, resourceStateEnv+"="+stateDir, "KB_RUNNER_SCRATCH="+scratch, "TMPDIR="+commandTempDir, "TMP="+commandTempDir, "TEMP="+commandTempDir)
	if cfg.GrantedCPUs > 0 || cfg.MemoryBytes > 0 {
		cmd.Env = append(cmd.Env, fmt.Sprintf("KB_RUNNER_CPUS=%d", cfg.GrantedCPUs), fmt.Sprintf("KB_RUNNER_MEM_BYTES=%d", cfg.MemoryBytes))
	}
	return child.Configure(cmd, child.ProcessGroup)
}
