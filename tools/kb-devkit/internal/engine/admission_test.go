package engine

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kb-labs/devkit/internal/config"
)

const gib = uint64(1) << 30

// admissionFixture is a workspace of independent packages whose build task
// registers itself in a marker directory while it runs. The fake host derives
// its available memory from those markers, so the probe sees what the real
// running tasks would hold.
type admissionFixture struct {
	t        *testing.T
	root     string
	markers  string
	startLog string
	run      func(RunOptions) RunResult
	total    uint64
	free     uint64 // constant available memory the fake host reports
	cache    bool   // keep the cache on (default: every run executes its tasks)
	taskMB   int
}

func newAdmissionFixture(t *testing.T, packages int, taskMB int, total, free uint64) *admissionFixture {
	t.Helper()
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	categories := make([]config.NamedCategory, 0, packages)
	for i := 0; i < packages; i++ {
		name := fmt.Sprintf("p%d", i)
		writePkg(t, filepath.Join(root, "packages", name), fmt.Sprintf(`{"name":"@fixture/%s"}`, name))
		categories = append(categories, config.NamedCategory{Name: name, Category: config.CategoryConfig{Match: []string{"packages/" + name}, Preset: "node-lib"}})
	}
	markers := filepath.Join(root, "markers")
	startLog := filepath.Join(root, "starts.log")
	if err := os.MkdirAll(markers, 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "task.sh")
	writeEngineFile(t, script, fmt.Sprintf("m=%q/$$\ntouch \"$m\"\nls %q | wc -l >> %q\nsleep 0.4\nrm \"$m\"\n", markers, markers, startLog))
	command := "sh " + script
	cfg := testConfig(categories)
	cfg.Tasks = map[string]config.TaskConfig{"build": {{Command: command}}}
	cfg.Run.TaskMemoryMB = taskMB
	ws := mustWorkspace(t, root, cfg)
	f := &admissionFixture{t: t, root: root, markers: markers, startLog: startLog, total: total, taskMB: taskMB}
	f.free = free
	f.run = func(opts RunOptions) RunResult {
		t.Helper()
		opts.Tasks, opts.WSRoot, opts.CacheRoot, opts.NoCache = []string{"build"}, root, filepath.Join(root, ".kb", "devkit"), !f.cache
		opts.Concurrency = packages
		if opts.Packages == nil {
			opts.Packages = ws.Packages
		}
		opts.AdmissionPollInterval = 10 * time.Millisecond
		opts.AdmissionSettle = time.Hour // every running task counts as not ramped up: the bound below is exact
		result, err := Run(ws, cfg, opts)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !result.OK {
			t.Fatalf("run failed: %+v", result.Results)
		}
		return result
	}
	return f
}

// probe is the fake host: constant memory, independent of timing.
func (f *admissionFixture) probe() (MemoryReading, error) {
	return MemoryReading{TotalBytes: f.total, AvailableBytes: f.free}, nil
}

func (f *admissionFixture) starts() []int {
	f.t.Helper()
	file, err := os.Open(f.startLog)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		f.t.Fatal(err)
	}
	defer file.Close()
	var counts []int
	sc := bufio.NewScanner(file)
	for sc.Scan() {
		var n int
		fmt.Sscanf(strings.TrimSpace(sc.Text()), "%d", &n)
		counts = append(counts, n)
	}
	return counts
}

func maxInt(values []int) int {
	peak := 0
	for _, v := range values {
		if v > peak {
			peak = v
		}
	}
	return peak
}

// fakeClock drives the gate's clock and poll timer from the test: a waiter
// re-evaluates only when the test ticks, never because wall-clock time passed.
type fakeClock struct {
	mu   sync.Mutex
	now  time.Time
	tick chan time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Unix(1_000_000, 0), tick: make(chan time.Time)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tick
}

// Advance moves the clock and wakes every waiter once.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	old := c.tick
	c.tick = make(chan time.Time)
	c.mu.Unlock()
	close(old)
}

// gateRig is an admission gate wired to the fake clock and a scripted probe.
type gateRig struct {
	t      *testing.T
	gate   *admission
	clock  *fakeClock
	avail  atomic.Uint64
	total  uint64
	probes atomic.Int64
	err    atomic.Value // error returned by the probe, nil when readable
}

func newGateRig(t *testing.T, cap, taskMB int, total, avail uint64) *gateRig {
	t.Helper()
	r := &gateRig{t: t, clock: newFakeClock(), total: total}
	r.avail.Store(avail)
	probe := func() (MemoryReading, error) {
		r.probes.Add(1)
		if e, _ := r.err.Load().(error); e != nil {
			return MemoryReading{}, e
		}
		return MemoryReading{TotalBytes: r.total, AvailableBytes: r.avail.Load()}, nil
	}
	r.gate = newAdmission(cap, taskMB, probe, time.Second, 10*time.Second)
	r.gate.now, r.gate.after = r.clock.Now, r.clock.After
	return r
}

// acquireAsync starts acquire in a goroutine; the returned channel yields the slot id.
func (r *gateRig) acquireAsync() <-chan int {
	ch := make(chan int, 1)
	go func() { ch <- r.gate.acquire() }()
	return ch
}

// waitUntil spins on a condition. The deadline only turns a bug into a failure
// instead of a hang; it is never what makes a passing test pass.
func (r *gateRig) waitUntil(what string, cond func() bool) {
	r.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			r.t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
	}
}

func (r *gateRig) waiting() int { return r.gate.sample(r.clock.Now()).Waiting }

// stillBlocked ticks the waiters once and proves they re-read the probe and
// stayed blocked.
func (r *gateRig) stillBlocked(ch <-chan int) {
	r.t.Helper()
	before := r.probes.Load()
	r.clock.Advance(time.Second)
	r.waitUntil("a re-evaluation after the tick", func() bool { return r.probes.Load() > before })
	select {
	case id := <-ch:
		r.t.Fatalf("task was admitted (slot %d) although memory does not allow it", id)
	default:
	}
}

func TestAdmissionHoldsTaskUntilMemoryFrees(t *testing.T) {
	r := newGateRig(t, 8, 1024, 16*gib, gib) // one task fits; two do not
	first := r.gate.acquire()                // nothing runs: always admitted
	second := r.acquireAsync()
	r.waitUntil("second task to wait", func() bool { return r.waiting() == 1 })
	r.stillBlocked(second)
	r.avail.Store(12 * gib)
	r.clock.Advance(time.Second)
	if id := <-second; id == first {
		t.Fatalf("slots collide: %d", id)
	}
}

func TestAdmissionReservesMemoryOfTasksThatHaveNotRampedUp(t *testing.T) {
	// 1.5 GiB available, 1 GiB tasks: the running task has not shown its
	// memory yet, so the second one waits until the settle window passes.
	r := newGateRig(t, 8, 1024, 16*gib, gib+gib/2)
	r.gate.acquire()
	second := r.acquireAsync()
	r.waitUntil("second task to wait", func() bool { return r.waiting() == 1 })
	r.stillBlocked(second)
	r.clock.Advance(r.gate.settle)
	<-second
}

func TestAdmissionNeverExceedsBudgetFractionOfTotal(t *testing.T) {
	// 4 GiB total, budget 0.7 -> 2.8 GiB: two 1 GiB tasks fit, a third never
	// does, however much the host reports available.
	r := newGateRig(t, 8, 1024, 4*gib, 64*gib)
	a := r.gate.acquire()
	r.clock.Advance(r.gate.settle)
	r.gate.acquire()
	third := r.acquireAsync()
	r.waitUntil("third task to wait", func() bool { return r.waiting() == 1 })
	r.stillBlocked(third)
	r.gate.release(a)
	<-third
}

func TestAdmissionRunsSeriallyWhenMemoryUnreadable(t *testing.T) {
	r := newGateRig(t, 8, 1024, 16*gib, 12*gib)
	r.err.Store(errors.New("meminfo unreadable"))
	first := r.gate.acquire()
	second := r.acquireAsync()
	r.waitUntil("second task to wait", func() bool { return r.waiting() == 1 })
	r.stillBlocked(second)
	if s := r.gate.sample(r.clock.Now()); s.ProbeError != "meminfo unreadable" || s.Waiting != 1 || s.Running != 1 {
		t.Fatalf("sample does not describe the blocked state: %+v", s)
	}
	r.gate.release(first)
	<-second
}

func TestAdmissionUnsupportedHostIsBoundedByCapAndSaysSo(t *testing.T) {
	r := newGateRig(t, 3, 1024, 16*gib, 0)
	r.err.Store(fmt.Errorf("%w: plan9 has no admission probe", ErrMemoryProbeUnsupported))
	var ids []int
	for i := 0; i < 3; i++ {
		ids = append(ids, r.gate.acquire())
	}
	fourth := r.acquireAsync()
	r.waitUntil("fourth task to wait on the cap", func() bool { return r.waiting() == 1 })
	select { // the cap check precedes any probe read, so there is nothing to re-evaluate
	case id := <-fourth:
		t.Fatalf("fourth task admitted (slot %d) beyond the cap", id)
	default:
	}
	if s := r.gate.sample(r.clock.Now()); !strings.Contains(s.ProbeError, "plan9") || s.Running != 3 {
		t.Fatalf("first-sample evidence missing the host: %+v", s)
	}
	r.gate.release(ids[0])
	<-fourth
}

func TestAdmissionSampleDescribesWaitingTasks(t *testing.T) {
	r := newGateRig(t, 8, 1024, 16*gib, gib)
	r.gate.acquire()
	second := r.acquireAsync()
	r.waitUntil("second task to wait", func() bool { return r.waiting() == 1 })
	s := r.gate.sample(r.clock.Now())
	if s.Running != 1 || s.Waiting != 1 || s.Admitted != 1 || s.Cap != 8 || s.TaskMemoryMB != 1024 || s.TotalBytes != 16*gib || s.AvailableBytes != gib || s.BudgetBytes == 0 {
		t.Fatalf("sample misses admission inputs: %+v", s)
	}
	r.avail.Store(12 * gib)
	r.clock.Advance(time.Second)
	<-second
}

func TestRunMemoryNeverExceedsBudget(t *testing.T) {
	// 4.5 GiB available with 1 GiB tasks: with every running task still
	// reserved, at most 4 of the 8 workers may run together.
	f := newAdmissionFixture(t, 8, 1024, 16*gib, 4*gib+gib/2)
	var mu sync.Mutex
	var samples []AdmissionSample
	f.run(RunOptions{
		MemoryProbe:    f.probe,
		SampleInterval: time.Hour, // only the immediate first sample
		OnSample: func(s AdmissionSample) {
			mu.Lock()
			samples = append(samples, s)
			mu.Unlock()
		},
	})
	starts := f.starts()
	if len(starts) != 8 {
		t.Fatalf("started %d tasks; want all 8 to finish", len(starts))
	}
	if peak := maxInt(starts); peak > 4 {
		t.Fatalf("peak concurrent tasks = %d; memory admits 4", peak)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(samples) == 0 || samples[0].Cap != 8 || samples[0].TaskMemoryMB != 1024 || samples[0].TotalBytes != 16*gib {
		t.Fatalf("first sample misses admission inputs: %+v", samples)
	}
}

func TestRunSerialWhenMemoryUnreadable(t *testing.T) {
	f := newAdmissionFixture(t, 3, 1024, 16*gib, 12*gib)
	f.run(RunOptions{MemoryProbe: func() (MemoryReading, error) { return MemoryReading{}, errors.New("meminfo unreadable") }})
	if peak := maxInt(f.starts()); peak != 1 {
		t.Fatalf("peak = %d with unknown memory; want serial execution", peak)
	}
}

func TestRunCacheHitsTakeNoMemoryReservation(t *testing.T) {
	f := newAdmissionFixture(t, 6, 1024, 16*gib, 12*gib)
	f.cache = true
	f.run(RunOptions{MemoryProbe: f.probe}) // populate the cache
	if len(f.starts()) != 6 {
		t.Fatalf("first run started %d tasks; want 6", len(f.starts()))
	}
	// A probe that admits only one task: every cached node would have to wait
	// for memory if cache hits reserved any. The run's final sample must show
	// that no node was ever admitted.
	var mu sync.Mutex
	var samples []AdmissionSample
	second := f.run(RunOptions{
		MemoryProbe: func() (MemoryReading, error) {
			return MemoryReading{TotalBytes: 16 * gib, AvailableBytes: gib}, nil
		},
		SampleInterval: time.Hour,
		OnSample: func(s AdmissionSample) {
			mu.Lock()
			samples = append(samples, s)
			mu.Unlock()
		},
	})
	for _, r := range second.Results {
		if !r.Cached {
			t.Fatalf("%s was not a cache hit", r.Package)
		}
	}
	if len(f.starts()) != 6 {
		t.Fatalf("cache hits launched processes: %d starts", len(f.starts()))
	}
	mu.Lock()
	defer mu.Unlock()
	if last := samples[len(samples)-1]; last.Admitted != 0 || last.Waiting != 0 {
		t.Fatalf("cache hits took memory admission: %+v", last)
	}
}

func TestParseMeminfoReadsTotalAndAvailable(t *testing.T) {
	reading, err := parseMeminfo(bufio.NewScanner(strings.NewReader("MemTotal:       16377000 kB\nMemFree: 1 kB\nMemAvailable:   11000000 kB\n")))
	if err != nil {
		t.Fatal(err)
	}
	if reading.TotalBytes != 16377000*1024 || reading.AvailableBytes != 11000000*1024 {
		t.Fatalf("reading = %+v", reading)
	}
	if _, err := parseMeminfo(bufio.NewScanner(strings.NewReader("MemTotal: 1 kB\n"))); err == nil {
		t.Fatal("missing MemAvailable must be an error")
	}
}

func TestParseVMStatSumsReclaimablePagesByHeaderPageSize(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "vm_stat_darwin.txt"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseVMStat(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	// Recorded on the macOS host: page size 16384; free 15235 + inactive 307686
	// + speculative 1449 + purgeable 652 pages.
	if want := uint64(15235+307686+1449+652) * 16384; got != want {
		t.Fatalf("available = %d; want %d", got, want)
	}
	if _, err := parseVMStat("Pages free: 1.\n"); err == nil {
		t.Fatal("missing page size header must be an error")
	}
	if _, err := parseVMStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\n"); err == nil {
		t.Fatal("missing counters must be an error")
	}
}

func TestLinuxMemoryClampsByCgroupV2Limit(t *testing.T) {
	dir := t.TempDir()
	meminfo := filepath.Join(dir, "meminfo")
	writeEngineFile(t, meminfo, "MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\n") // 16 GiB / 12 GiB
	cg := filepath.Join(dir, "cgroup")
	if err := os.MkdirAll(cg, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := linuxMemory(meminfo, cg) // no memory.max: host values
	if err != nil || got.TotalBytes != 16*gib || got.AvailableBytes != 12*gib {
		t.Fatalf("no cgroup file: %+v, %v", got, err)
	}
	writeEngineFile(t, filepath.Join(cg, "memory.max"), "max\n")
	if got, err = linuxMemory(meminfo, cg); err != nil || got.TotalBytes != 16*gib {
		t.Fatalf("memory.max=max: %+v, %v", got, err)
	}
	writeEngineFile(t, filepath.Join(cg, "memory.max"), fmt.Sprintf("%d\n", 4*gib))
	writeEngineFile(t, filepath.Join(cg, "memory.current"), fmt.Sprintf("%d\n", gib))
	if got, err = linuxMemory(meminfo, cg); err != nil || got.TotalBytes != 4*gib || got.AvailableBytes != 3*gib {
		t.Fatalf("limited cgroup: %+v, %v; want total 4 GiB, available 3 GiB", got, err)
	}
}
