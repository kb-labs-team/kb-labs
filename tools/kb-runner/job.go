//go:build darwin || linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

type JobPhase string

const (
	PhaseWorktree  JobPhase = "worktree"
	PhaseInstall   JobPhase = "install"
	PhaseBuild     JobPhase = "build"
	PhaseAdmission JobPhase = "admission"
	PhaseRun       JobPhase = "run"
)

type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobOK        JobState = "ok"
	JobFailed    JobState = "failed"
	JobStalled   JobState = "stalled"
	JobLost      JobState = "lost"
	JobCancelled JobState = "cancelled"
	JobPaused    JobState = "paused"
	JobQuotaWait JobState = "quota-wait"
)

func (s JobState) Terminal() bool {
	return s == JobOK || s == JobFailed || s == JobStalled || s == JobLost || s == JobCancelled
}
func (s JobState) Attention() bool { return s == JobPaused || s == JobQuotaWait }

func (j Job) eventTime() time.Time {
	if j.Final != nil && !j.Final.FinishedAt.IsZero() {
		return j.Final.FinishedAt
	}
	return j.UpdatedAt
}
func (j Job) cursor() string { return fmt.Sprintf("%020d:%s", j.eventTime().UnixNano(), j.ID) }

type JobReason string

const (
	ReasonNone                JobReason = ""
	ReasonSetup               JobReason = "setup_failed"
	ReasonQuota               JobReason = "quota_limit"
	ReasonProviderUnreachable JobReason = "provider_unreachable"
	ReasonRateLimited         JobReason = "rate_limited"
	ReasonAuthExpired         JobReason = "auth_expired"
	ReasonVendorError         JobReason = "vendor_error"
	ReasonStall               JobReason = "no_activity"
	ReasonProcessLost         JobReason = "process_lost"
)

type JobTerminal struct {
	State              JobState  `json:"state"`
	Phase              JobPhase  `json:"phase"`
	Reason             JobReason `json:"reason,omitempty"`
	Error              string    `json:"error,omitempty"`
	Next               string    `json:"next"`
	MessagePath        string    `json:"messagePath,omitempty"`
	SessionID          string    `json:"sessionId,omitempty"`
	TempReclaimedBytes *uint64   `json:"tempReclaimedBytes,omitempty"`
	TempCleanupError   string    `json:"tempCleanupError,omitempty"`
	TempCleanupPath    string    `json:"tempCleanupPath,omitempty"`
	FinishedAt         time.Time `json:"finishedAt"`
}

// Attempt usage accounting: "recorded" means the attempt's observed token
// usage was recorded in the job totals; "unknown" means the vendor exposes no
// usage for how this attempt ended, so the job totals are incomplete.
const (
	attemptUsageRecorded = "recorded"
	attemptUsageUnknown  = "unknown"
)

type ProviderAttempt struct {
	Number     int       `json:"number"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt,omitempty"`
	SessionID  string    `json:"sessionId,omitempty"`
	Reason     JobReason `json:"reason,omitempty"`
	Outcome    string    `json:"outcome"`
	Usage      string    `json:"usage"`
}
type Job struct {
	ID              string            `json:"id"`
	Stream          string            `json:"stream"`
	Vendor          string            `json:"vendor"`
	Model           string            `json:"model,omitempty"`
	State           JobState          `json:"state"`
	Phase           JobPhase          `json:"phase"`
	Reason          JobReason         `json:"reason,omitempty"`
	StartedAt       time.Time         `json:"startedAt"`
	UpdatedAt       time.Time         `json:"updatedAt"`
	LastActivity    time.Time         `json:"lastActivity,omitempty"`
	SessionID       string            `json:"sessionId,omitempty"`
	MessagePath     string            `json:"messagePath,omitempty"`
	Tokens          uint64            `json:"tokens,omitempty"`
	InputTokens     uint64            `json:"inputTokens,omitempty"`
	OutputTokens    uint64            `json:"outputTokens,omitempty"`
	SlotGroup       string            `json:"slotGroup,omitempty"`
	SlotCeiling     int               `json:"slotCeiling,omitempty"`
	RunID           string            `json:"runId,omitempty"`
	WorkerPID       int               `json:"workerPid,omitempty"`
	WorkerStartedAt string            `json:"workerStartedAt,omitempty"`
	Attempts        []ProviderAttempt `json:"attempts,omitempty"`
	Final           *JobTerminal      `json:"terminal,omitempty"`
}

type jobStore struct {
	dir     string
	mu      sync.Mutex
	stateIO runnerStateStore
}

func newJobStore(dir string) *jobStore {
	return newJobStoreWithStateIO(dir, filesystemRunnerStateStore{})
}
func newJobStoreWithStateIO(dir string, stateIO runnerStateStore) *jobStore {
	if stateIO == nil {
		panic("job store requires a runner state store")
	}
	return &jobStore{dir: filepath.Join(dir, "jobs"), stateIO: stateIO}
}
func (s *jobStore) path(id string) string { return filepath.Join(s.dir, id+".json") }
func (s *jobStore) terminalPath(id string) string {
	return filepath.Join(s.dir, id+".terminal.json")
}
func validateJobID(id string) error {
	if strings.TrimSpace(id) == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
		return errors.New("job ID must be a non-empty filename-safe value")
	}
	return nil
}
func (s *jobStore) lockJob(id string) (*os.File, error) {
	if err := validateJobID(id); err != nil {
		return nil, err
	}
	jobDir := filepath.Dir(zcodeJobTemp(AgentRequest{StateDir: filepath.Dir(s.dir), JobID: id}))
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		return nil, fmt.Errorf("create job lock directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(jobDir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open job lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return nil, errors.Join(fmt.Errorf("lock job: %w", err), file.Close())
	}
	return file, nil
}
func unlockJob(file *os.File) error {
	unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	closeErr := file.Close()
	return errors.Join(unlockErr, closeErr)
}
func (s *jobStore) Create(job Job) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateJobID(job.ID); err != nil {
		return Job{}, err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return Job{}, err
	}
	if _, err := os.Stat(s.path(job.ID)); err == nil {
		return Job{}, fmt.Errorf("job %q already exists", job.ID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Job{}, err
	}
	if _, err := os.Stat(s.terminalPath(job.ID)); err == nil {
		return Job{}, fmt.Errorf("job %q already exists", job.ID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Job{}, err
	}
	now := time.Now().UTC()
	if job.StartedAt.IsZero() {
		job.StartedAt = now
	}
	if job.UpdatedAt.IsZero() {
		job.UpdatedAt = now
	}
	if job.LastActivity.IsZero() {
		job.LastActivity = now
	}
	if job.State == "" {
		job.State = JobQueued
	}
	return job, s.write(job)
}
func (s *jobStore) Get(id string) (Job, error) {
	if err := validateJobID(id); err != nil {
		return Job{}, err
	}
	job, jobErr := readJobFile(s.path(id))
	terminal, terminalErr := readJobFile(s.terminalPath(id))
	if jobErr != nil {
		if terminalErr == nil {
			if terminal.Final == nil {
				return Job{}, errors.New("terminal record file does not contain a terminal outcome")
			}
			return terminal, nil
		}
		if terminalErr != nil && !errors.Is(terminalErr, os.ErrNotExist) {
			return Job{}, errors.Join(fmt.Errorf("read job record: %w", jobErr), fmt.Errorf("read terminal record: %w", terminalErr))
		}
		return Job{}, jobErr
	}
	if terminalErr != nil {
		if errors.Is(terminalErr, os.ErrNotExist) {
			return job, nil
		}
		return Job{}, fmt.Errorf("read terminal record: %w", terminalErr)
	}
	if terminal.Final == nil {
		return Job{}, errors.New("terminal record file does not contain a terminal outcome")
	}
	if job.Final != nil {
		return Job{}, errors.New("job has both a primary and fallback terminal outcome")
	}
	job.State = terminal.State
	job.Phase = terminal.Phase
	job.Reason = terminal.Reason
	job.UpdatedAt = terminal.UpdatedAt
	job.SessionID = terminal.SessionID
	job.MessagePath = terminal.MessagePath
	job.Final = terminal.Final
	return job, nil
}

func (s *jobStore) reconcileWorker(job Job) (Job, error) {
	if job.State != JobRunning {
		return job, nil
	}
	next := shellQuote(os.Args[0]) + " ps --state " + shellQuote(filepath.Dir(s.dir)) + " --json"
	if job.RunID == "" || job.WorkerPID <= 0 || job.WorkerStartedAt == "" {
		return Job{}, fmt.Errorf("job %s has no complete clikit run and worker identity; process liveness is unknown; next: %s", job.ID, next)
	}
	alive, err := proc.RunOwnsProcess(filepath.Dir(s.dir), job.RunID, job.WorkerPID, job.WorkerStartedAt)
	if err != nil {
		return Job{}, fmt.Errorf("inspect clikit run %s for worker PID %d of job %s: %w; next: %s", job.RunID, job.WorkerPID, job.ID, err, next)
	}
	if alive {
		return job, nil
	}
	return s.markJobLost(job, fmt.Sprintf("worker PID %d identity %s is not owned by live clikit run %s", job.WorkerPID, job.WorkerStartedAt, job.RunID))
}

func (s *jobStore) markJobLost(job Job, reason string) (Job, error) {
	if err := s.Terminate(job.ID, JobTerminal{
		State: JobLost, Phase: job.Phase, Reason: ReasonProcessLost,
		Error: reason,
		Next:  s.statusCommand(),
	}); err != nil {
		current, readErr := s.Get(job.ID)
		if readErr == nil && current.Final != nil && current.State.Terminal() {
			return current, nil
		}
		return Job{}, fmt.Errorf("classify lost worker for job %s: %w", job.ID, err)
	}
	return s.Get(job.ID)
}

func (s *jobStore) statusCommand() string {
	return shellQuote(os.Args[0]) + " status --state " + shellQuote(filepath.Dir(s.dir)) + " --json"
}

func readJobFile(path string) (Job, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Job{}, err
	}
	var job Job
	if err := json.Unmarshal(b, &job); err != nil {
		return Job{}, err
	}
	return job, nil
}
func (s *jobStore) write(j Job) error {
	b, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	return s.stateIO.AtomicWrite(s.path(j.ID), b)
}

type runnerStateStore interface {
	AtomicWrite(path string, data []byte) error
	Append(path string, data []byte, mode os.FileMode) error
	GitMutation(dir string, environment []string, args ...string) (string, error)
}

type filesystemRunnerStateStore struct{}

func (filesystemRunnerStateStore) AtomicWrite(path string, b []byte) (returnErr error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-write-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() {
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove state-write temporary file: %w", err))
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if _, err := tmp.Write(b); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if err := tmp.Sync(); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	if err := errors.Join(directory.Sync(), directory.Close()); err != nil {
		return err
	}
	return nil
}

func (filesystemRunnerStateStore) Append(path string, b []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(b)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return nil
}

func (filesystemRunnerStateStore) GitMutation(dir string, environment []string, args ...string) (string, error) {
	gitArgs := append([]string{"-C", dir}, args...)
	command := exec.Command("git", gitArgs...)
	command.Dir = dir
	command.Env = append(os.Environ(), environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("git %s failed: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

func writeAtomicFile(path string, data []byte) error {
	return filesystemRunnerStateStore{}.AtomicWrite(path, data)
}

func appendDurableFile(path string, data []byte, mode os.FileMode) error {
	return filesystemRunnerStateStore{}.Append(path, data, mode)
}
func (s *jobStore) writeTerminalFallback(id string, terminal JobTerminal) error {
	if !terminal.State.Terminal() {
		return fmt.Errorf("state %q is not terminal", terminal.State)
	}
	if terminal.FinishedAt.IsZero() {
		terminal.FinishedAt = time.Now().UTC()
	}
	job := Job{ID: id, State: terminal.State, Phase: terminal.Phase, Reason: terminal.Reason, UpdatedAt: terminal.FinishedAt, SessionID: terminal.SessionID, MessagePath: terminal.MessagePath, Final: &terminal}
	b, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	return s.stateIO.AtomicWrite(s.terminalPath(id), b)
}
func (s *jobStore) Terminate(id string, terminal JobTerminal) (returnErr error) {
	if !terminal.State.Terminal() {
		return fmt.Errorf("state %q is not terminal", terminal.State)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, err := s.lockJob(id)
	if err != nil {
		return err
	}
	defer func() {
		if err := unlockJob(lock); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("unlock job %s: %w", id, err))
		}
	}()
	j, err := s.Get(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return err
		}
		reclaimed, found, cleanupErr, cleanupPath := reapJobTemp(s.dir, id)
		if found {
			terminal.TempReclaimedBytes = &reclaimed
		}
		terminal.TempCleanupError, terminal.TempCleanupPath = cleanupErr, cleanupPath
		if fallbackErr := s.writeTerminalFallback(id, terminal); fallbackErr != nil {
			return errors.Join(fmt.Errorf("read job before termination: %w", err), fmt.Errorf("persist fallback terminal record: %w", fallbackErr))
		}
		return nil
	}
	if j.Final != nil {
		return fmt.Errorf("job %q already has a terminal record", id)
	}
	reclaimed, found, cleanupErr, cleanupPath := reapJobTemp(s.dir, id)
	if found {
		terminal.TempReclaimedBytes = &reclaimed
	}
	terminal.TempCleanupError, terminal.TempCleanupPath = cleanupErr, cleanupPath
	terminal.FinishedAt = time.Now().UTC()
	j.State = terminal.State
	j.Phase = terminal.Phase
	j.Reason = terminal.Reason
	j.UpdatedAt = terminal.FinishedAt
	j.Final = &terminal
	if err := s.write(j); err != nil {
		if fallbackErr := s.writeTerminalFallback(id, terminal); fallbackErr != nil {
			return errors.Join(fmt.Errorf("persist primary terminal record: %w", err), fmt.Errorf("persist fallback terminal record: %w", fallbackErr))
		}
	}
	return nil
}
func (s *jobStore) Update(id string, fn func(*Job) error) (returnErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, err := s.lockJob(id)
	if err != nil {
		return err
	}
	defer func() {
		if err := unlockJob(lock); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("unlock job %s: %w", id, err))
		}
	}()
	j, err := s.Get(id)
	if err != nil {
		return err
	}
	if j.Final != nil {
		return fmt.Errorf("job %q already has a terminal record", id)
	}
	if err := fn(&j); err != nil {
		return err
	}
	j.UpdatedAt = time.Now().UTC()
	return s.write(j)
}
func (s *jobStore) List() ([]Job, error) {
	jobs, err := s.ListRecords()
	if err != nil {
		return nil, err
	}
	for index := range jobs {
		jobs[index], err = s.reconcileWorker(jobs[index])
		if err != nil {
			return nil, err
		}
	}
	return jobs, nil
}

func (s *jobStore) ListRecords() ([]Job, error) {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Job{}, nil
	}
	if err != nil {
		return nil, err
	}
	ids := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if id, ok := strings.CutSuffix(name, ".terminal.json"); ok {
			ids[id] = struct{}{}
			continue
		}
		if filepath.Ext(name) == ".json" {
			ids[strings.TrimSuffix(name, ".json")] = struct{}{}
		}
	}
	out := make([]Job, 0, len(ids))
	for id := range ids {
		j, e := s.Get(id)
		if e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].StartedAt.Before(out[j].StartedAt)
	})
	return out, nil
}

// reconcileJobsForState lets commands that also read the process-run registry
// classify agent workers when the shared state root is available. Invalid or
// inaccessible roots are left to that registry's owner to diagnose.
func reconcileJobsForState(state string) error {
	info, err := os.Stat(state)
	if err != nil || !info.IsDir() {
		return nil
	}
	_, err = newJobStore(state).List()
	return err
}

func (s *jobStore) Wait(ids []string, all bool, since string) ([]Job, string, error) {
	if since != "" {
		if _, _, ok := strings.Cut(since, ":"); !ok {
			return nil, "", fmt.Errorf("invalid job cursor %q", since)
		}
		if _, err := strconv.ParseInt(strings.SplitN(since, ":", 2)[0], 10, 64); err != nil {
			return nil, "", fmt.Errorf("invalid job cursor %q", since)
		}
	}
	jobs, err := s.List()
	if err != nil {
		return nil, "", err
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	var matched []Job
	for _, j := range jobs {
		if !wanted[j.ID] && !wanted[j.Stream] {
			continue
		}
		if !j.State.Terminal() && !j.State.Attention() {
			continue
		}
		if since != "" && j.cursor() <= since {
			continue
		}
		matched = append(matched, j)
	}
	sort.Slice(matched, func(i, j int) bool {
		if matched[i].eventTime().Equal(matched[j].eventTime()) {
			return matched[i].ID < matched[j].ID
		}
		return matched[i].eventTime().Before(matched[j].eventTime())
	})
	if all && len(matched) < len(ids) {
		return nil, "", nil
	}
	if len(matched) == 0 {
		return nil, "", nil
	}
	if !all {
		matched = matched[:1]
	}
	return matched, matched[len(matched)-1].cursor(), nil
}

type VendorLimit struct {
	Vendor      string         `json:"vendor"`
	Window      string         `json:"window"`
	UsedPercent float64        `json:"usedPercent"`
	Blocked     bool           `json:"blocked,omitempty"`
	ResetsAt    *time.Time     `json:"resetsAt,omitempty"`
	Confidence  string         `json:"confidence"`
	Source      string         `json:"source"`
	Error       string         `json:"error,omitempty"`
	FetchedAt   time.Time      `json:"fetchedAt"`
	RecordedAt  *time.Time     `json:"recordedAt,omitempty"`
	Age         string         `json:"age,omitempty"`
	Stale       bool           `json:"stale,omitempty"`
	Pace        *ClaudePace    `json:"pace,omitempty"`
	Attempts    []LimitAttempt `json:"attempts,omitempty"`
	Spend       *VendorSpend   `json:"spend,omitempty"`
}

type VendorSpend struct {
	ThisJob   uint64 `json:"thisJob"`
	Total     uint64 `json:"total"`
	Grant     uint64 `json:"grant,omitempty"`
	Remaining uint64 `json:"remaining,omitempty"`
	HasGrant  bool   `json:"hasGrant"`
	// UnknownAttempts counts attempts whose usage the vendor never exposed;
	// the totals exclude their spend instead of counting it as zero.
	UnknownAttempts int `json:"unknownAttempts,omitempty"`
}
type AgentStatus struct {
	Jobs        []Job         `json:"jobs"`
	Limits      []VendorLimit `json:"limits"`
	DailyTokens []DailyTokens `json:"dailyTokens"`
}

type DailyTokens struct {
	Vendor string `json:"vendor"`
	Day    string `json:"day"`
	Tokens uint64 `json:"tokens"`
}

func dailyTokenTotals(jobs []Job) []DailyTokens {
	totals := map[string]uint64{}
	for _, job := range jobs {
		if job.Tokens == 0 || job.StartedAt.IsZero() {
			continue
		}
		day := job.StartedAt.UTC().Format("2006-01-02")
		key := job.Vendor + "\x00" + day
		totals[key] += job.Tokens
	}
	out := make([]DailyTokens, 0, len(totals))
	for key, tokens := range totals {
		parts := strings.SplitN(key, "\x00", 2)
		out = append(out, DailyTokens{Vendor: parts[0], Day: parts[1], Tokens: tokens})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Day == out[j].Day {
			return out[i].Vendor < out[j].Vendor
		}
		return out[i].Day < out[j].Day
	})
	return out
}
