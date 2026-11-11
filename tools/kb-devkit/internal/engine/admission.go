package engine

import (
	"errors"
	"sync"
	"time"
)

// memoryBudgetFraction is the share of total host memory build workers may
// occupy; the rest is left to the OS, the runner agent and page cache.
const memoryBudgetFraction = 0.7

// DefaultAdmissionSettle is how long a freshly started task is assumed to be
// still ramping up: its estimated memory is reserved on top of what the host
// reports as available, because the host does not show that memory yet.
const DefaultAdmissionSettle = 10 * time.Second

// DefaultAdmissionPollInterval is how often a waiting task re-reads the memory
// probe when no running task has finished in the meantime.
const DefaultAdmissionPollInterval = 2 * time.Second

// ErrMemoryProbeUnsupported is returned by a probe on hosts it cannot read.
var ErrMemoryProbeUnsupported = errors.New("memory probe is not supported on this platform")

// MemoryReading is one host memory observation in bytes.
type MemoryReading struct {
	TotalBytes     uint64
	AvailableBytes uint64
}

// MemoryProbe reads current host memory. It is injected so the scheduler never
// depends on the real host in tests.
type MemoryProbe func() (MemoryReading, error)

// AdmissionSample is one periodic record of the admission state. The last one
// in a log tells what the host looked like before a runner died.
type AdmissionSample struct {
	SampledAt      time.Time `json:"sampledAt"`
	Running        int       `json:"running"`
	Waiting        int       `json:"waiting"`
	Admitted       int       `json:"admitted"`
	Cap            int       `json:"cap"`
	TaskMemoryMB   int       `json:"taskMemoryMb"`
	TotalBytes     uint64    `json:"totalBytes,omitempty"`
	AvailableBytes uint64    `json:"availableBytes,omitempty"`
	BudgetBytes    uint64    `json:"budgetBytes,omitempty"` // ceiling for all running tasks together
	ProbeError     string    `json:"probeError,omitempty"`
}

// admission decides when a task process may start. It is acquired around the
// real process launch only: cache hits and skipped tasks never reserve memory.
// cap is an upper bound on running processes; memory is the real limiter. One task is always admitted when nothing
// runs, so a tight host slows the build down instead of deadlocking it.
type admission struct {
	cap          int
	taskBytes    uint64 // 0 disables memory admission
	probe        MemoryProbe
	pollInterval time.Duration
	settle       time.Duration
	now          func() time.Time
	after        func(time.Duration) <-chan time.Time // poll timer; injected so tests never wait on wall-clock time
	mu           sync.Mutex
	nextID       int
	started      map[int]time.Time // running tasks and when they were admitted
	waiting      int
	admitted     int
	wake         chan struct{}
}

func newAdmission(cap int, taskMemoryMB int, probe MemoryProbe, poll, settle time.Duration) *admission {
	if poll <= 0 {
		poll = DefaultAdmissionPollInterval
	}
	if settle <= 0 {
		settle = DefaultAdmissionSettle
	}
	return &admission{
		cap:          cap,
		taskBytes:    uint64(taskMemoryMB) * 1024 * 1024,
		probe:        probe,
		pollInterval: poll,
		settle:       settle,
		now:          time.Now,
		after:        time.After,
		started:      map[int]time.Time{},
		wake:         make(chan struct{}),
	}
}

// acquire blocks until the task may start and returns the id to release.
func (a *admission) acquire() int {
	a.mu.Lock()
	a.waiting++
	for {
		if a.canAdmitLocked() {
			a.waiting--
			id := a.nextID
			a.nextID++
			a.started[id] = a.now()
			a.admitted++
			a.mu.Unlock()
			return id
		}
		wake := a.wake
		a.mu.Unlock()
		select {
		case <-wake:
		case <-a.after(a.pollInterval):
		}
		a.mu.Lock()
	}
}

func (a *admission) release(id int) {
	a.mu.Lock()
	delete(a.started, id)
	close(a.wake)
	a.wake = make(chan struct{})
	a.mu.Unlock()
}

func (a *admission) canAdmitLocked() bool {
	running := len(a.started)
	if running >= a.cap {
		return false
	}
	if running == 0 || a.taskBytes == 0 || a.probe == nil {
		return true
	}
	reading, err := a.probe()
	if errors.Is(err, ErrMemoryProbeUnsupported) {
		return true // bounded by cap alone; samples state the host is unsupported
	}
	if err != nil {
		return false // memory unknown: run serially until the probe recovers
	}
	return a.fitsLocked(reading)
}

// fitsLocked admits one more task when the running tasks plus the candidate
// stay within the budget fraction of total memory, and the host's available
// memory covers the candidate plus the tasks that have not ramped up yet.
func (a *admission) fitsLocked(r MemoryReading) bool {
	running := uint64(len(a.started))
	return (running+1)*a.taskBytes <= a.limit(r) && r.AvailableBytes >= (a.youngLocked()+1)*a.taskBytes
}

func (a *admission) limit(r MemoryReading) uint64 {
	return uint64(float64(r.TotalBytes) * memoryBudgetFraction)
}

func (a *admission) youngLocked() uint64 {
	now := a.now()
	var young uint64
	for _, at := range a.started {
		if now.Sub(at) < a.settle {
			young++
		}
	}
	return young
}

func (a *admission) sample(now time.Time) AdmissionSample {
	a.mu.Lock()
	running, waiting, admitted := len(a.started), a.waiting, a.admitted
	a.mu.Unlock()
	s := AdmissionSample{
		SampledAt: now, Running: running, Waiting: waiting, Admitted: admitted,
		Cap: a.cap, TaskMemoryMB: int(a.taskBytes / (1024 * 1024)),
	}
	if a.probe == nil {
		return s
	}
	reading, err := a.probe()
	if err != nil {
		s.ProbeError = err.Error()
		return s
	}
	s.TotalBytes, s.AvailableBytes = reading.TotalBytes, reading.AvailableBytes
	s.BudgetBytes = a.limit(reading)
	return s
}
