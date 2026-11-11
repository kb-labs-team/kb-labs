//go:build darwin || linux

package proc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"

	clikitproc "github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
)

func TestInventoryKeepsUnobservableArgvVisible(t *testing.T) {
	process := Process{PID: 812, PPID: 1, Identity: "812:started", uid: 501}
	identity := func(int) (string, bool, error) { return process.Identity, true, nil }
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, syscall.EACCES
	}, identity)
	if !include || !entry.Unverified || entry.ArgvError == "" || entry.PID != process.PID ||
		entry.SettleMS != inventorySettleWindow.Milliseconds() || entry.Samples != inventorySettleSamples {
		t.Fatalf("denied argv observation = %+v, included=%t; want visible unverified entry", entry, include)
	}
	entry, include = inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, syscall.ESRCH
	}, func(int) (string, bool, error) {
		return "", false, nil
	})
	if include {
		t.Fatalf("process gone between snapshot and argv read returned %+v; want it omitted", entry)
	}
}

// case: S-276.6
func TestInventoryOmitsProcessGoneBetweenSnapshotAndCWDRead(t *testing.T) {
	process := Process{PID: 840, Identity: "840:started", uid: 501}
	identityReads := 0
	entry, include := inventoryEntryWithReaders(process, 501,
		func(int) ([]string, error) { return []string{"worker"}, nil },
		func(int) (string, bool, error) {
			identityReads++
			if identityReads == 1 {
				return "", false, syscall.ESRCH
			}
			return process.Identity, true, nil
		},
		func(int) (string, error) { return "", syscall.ESRCH },
	)
	if include || identityReads != 1 {
		t.Fatalf("process gone during cwd read remained in inventory: %+v reads=%d", entry, identityReads)
	}
}

// case: S-276.6
func TestInventoryReportsForeignUIDCWDReadFailure(t *testing.T) {
	process := Process{PID: 841, Identity: "841:foreign", uid: 0}
	entry, include := inventoryEntryWithReaders(process, 501,
		func(int) ([]string, error) { t.Fatal("foreign argv must not be read"); return nil, nil },
		func(int) (string, bool, error) { return process.Identity, true, nil },
		func(int) (string, error) { return "", syscall.EACCES },
	)
	if !include || entry.UID != 0 || entry.CwdError == "" || entry.ObservationError != "" {
		t.Fatalf("foreign cwd denial classification = %+v, included=%t", entry, include)
	}
}

// case: S-276.6
func TestInventoryReportsCurrentUIDCWDReadFailure(t *testing.T) {
	process := Process{PID: 842, Identity: "842:started", uid: 501}
	entry, include := inventoryEntryWithReaders(process, 501,
		func(int) ([]string, error) { return []string{"worker", "--workdir", "/work/agent/x"}, nil },
		func(int) (string, bool, error) { return process.Identity, true, nil },
		func(int) (string, error) { return "", syscall.EACCES },
	)
	if !include || entry.UID != 501 || entry.CwdError == "" || entry.Unverified {
		t.Fatalf("current-user cwd denial classification = %+v, included=%t", entry, include)
	}
}

func TestInventoryForeignUIDJSONExplicitlyMarksNoObservationError(t *testing.T) {
	process := Process{PID: 831, PPID: 1, Identity: "831:foreign", uid: 0}
	identityReads := 0
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		t.Fatal("foreign-uid argv must remain out of scope")
		return nil, nil
	}, func(int) (string, bool, error) {
		identityReads++
		return process.Identity, true, nil
	})
	if !include || entry.Unverified || entry.Samples != 0 || entry.ArgvError == "" || identityReads != 1 {
		t.Fatalf("foreign-uid classification = %+v, included=%t; want out-of-scope row", entry, include)
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	if err := json.Unmarshal(encoded, &row); err != nil {
		t.Fatal(err)
	}
	if value, exists := row["observation_error"]; !exists || value != "" {
		t.Fatalf("foreign-uid JSON row observation_error = %#v (present=%t), want explicit empty string: %s",
			value, exists, encoded)
	}
}

func TestInventoryOmitsPIDReusedDuringArgvRead(t *testing.T) {
	process := Process{PID: 814, PPID: 1, Identity: "814:original", uid: 501}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return []string{"replacement-process"}, nil
	}, func(int) (string, bool, error) {
		return "814:replacement", true, nil
	})
	if include {
		t.Fatalf("inventory included a reused PID with new identity: %+v", entry)
	}
}

// case: S-237.22
func TestInventoryOmitsProcessGoneAfterArgvReadError(t *testing.T) {
	process := Process{PID: 816, PPID: 1, Identity: "816:started", uid: 501}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, syscall.EINVAL
	}, func(int) (string, bool, error) {
		return "", false, nil
	})
	if include {
		t.Fatalf("FAILED PREDICATE [inventory.einval-gone-omitted]: argv EINVAL followed by a gone identity returned %+v", entry)
	}
}

// case: S-237.22
func TestInventoryOmitsReusedProcessAfterArgvReadError(t *testing.T) {
	process := Process{PID: 817, PPID: 1, Identity: "817:original", uid: 501}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, syscall.EINVAL
	}, func(int) (string, bool, error) {
		return "817:replacement", true, nil
	})
	if include {
		t.Fatalf("FAILED PREDICATE [inventory.reused-after-argv-error-omitted]: replacement identity returned %+v", entry)
	}
}

// case: S-237.22
func TestInventoryOmitsRealZombieChild(t *testing.T) {
	child, reap := startZombieChild(t)
	startedAt, identity, alive, err := readProcessStartIdentity(child.Process.Pid)
	if err != nil || alive || startedAt.IsZero() || identity == "" {
		t.Fatalf("zombie root start identity = (%s, %q, alive=%t, err=%v); want its PID/start identity with alive=false", startedAt, identity, alive, err)
	}
	if err := syscall.Kill(child.Process.Pid, 0); err != nil {
		t.Fatalf("fixture child PID %d was reaped before inventory: %v", child.Process.Pid, err)
	}

	entries, err := ProcessInventory()
	if err != nil {
		t.Fatalf("inventory process table with a real zombie: %v", err)
	}
	for _, entry := range entries {
		if entry.PID == child.Process.Pid {
			t.Fatalf("FAILED PREDICATE [inventory.zombie-omitted]: zombie PID %d was returned as %+v", child.Process.Pid, entry)
		}
	}
	if err := reap(); err != nil {
		t.Fatalf("reap zombie fixture child after inventory: %v", err)
	}
}

// case: S-261.6
func TestZombieRootIdentityRemainsAvailableForManagedChild(t *testing.T) {
	child, reap := startZombieChild(t)
	root, err := clikitproc.ChildProcessObserver().RootIdentity(child.Process.Pid)
	if err != nil {
		t.Fatalf("capture zombie root identity: %v", err)
	}
	if root.PID != child.Process.Pid || root.Identity == "" || root.StartedAt.IsZero() {
		t.Fatalf("zombie root identity = %+v, want PID/start identity", root)
	}
	if err := reap(); err != nil {
		t.Fatalf("reap zombie root: %v", err)
	}
}

func startZombieChild(t *testing.T) (*exec.Cmd, func() error) {
	t.Helper()
	child := exec.Command("/bin/sh", "-c", "exit 0")
	if err := child.Start(); err != nil {
		t.Fatalf("start zombie fixture child: %v", err)
	}
	waited := false
	reap := func() error {
		if waited {
			return nil
		}
		err := child.Wait()
		waited = true
		return err
	}
	t.Cleanup(func() {
		if err := reap(); err != nil {
			t.Errorf("reap zombie fixture child during cleanup: %v", err)
		}
	})
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		_, alive, err := ProcessIdentity(child.Process.Pid)
		if err != nil {
			t.Fatalf("inspect zombie fixture identity: %v", err)
		}
		if !alive {
			if err := syscall.Kill(child.Process.Pid, 0); err != nil {
				t.Fatalf("fixture PID %d is gone instead of remaining as an unreaped zombie: %v", child.Process.Pid, err)
			}
			return child, reap
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fixture child PID %d did not reach zombie state", child.Process.Pid)
	return nil, nil
}

func TestInventoryRetainsIdentityObservationFailure(t *testing.T) {
	process := Process{PID: 815, PPID: 1, Identity: "815:started", uid: 501}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return []string{"command"}, nil
	}, func(int) (string, bool, error) {
		return "", false, syscall.EACCES
	})
	if !include || entry.Unverified || entry.ObservationError == "" || entry.Samples != inventorySettleSamples {
		t.Fatalf("identity observation error = %+v, included=%t; want visible unresolved observation after settling", entry, include)
	}
}

// case: S-237.23
func TestInventoryExecExitStormSettlesTransientFailures(t *testing.T) {
	for iteration := 0; iteration < 20; iteration++ {
		process := Process{PID: 9100 + iteration, PPID: 1, Identity: fmt.Sprintf("%d:storm", 9100+iteration), uid: 501}
		argumentReads := 0
		entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
			argumentReads++
			if argumentReads == 1 {
				return nil, syscall.EIO
			}
			return []string{"/usr/bin/true", "storm-child"}, nil
		}, func(int) (string, bool, error) {
			return process.Identity, true, nil
		})
		if !include || entry.Unverified || entry.ObservationError != "" || len(entry.Argv) != 2 || argumentReads < 2 {
			t.Fatalf("FAILED PREDICATE [inventory.storm.no-transient-unverified]: iteration=%d reads=%d entry=%+v included=%t",
				iteration, argumentReads, entry, include)
		}
	}
}

// case: S-237.23
func TestInventoryJSONExposesSettlingEvidence(t *testing.T) {
	process := Process{PID: 9123, Identity: "9123:started", uid: 501}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, syscall.EACCES
	}, func(int) (string, bool, error) {
		return process.Identity, true, nil
	})
	if !include || !entry.Unverified {
		t.Fatalf("stable unreadable process was not retained: %+v", entry)
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal settled inventory row: %v", err)
	}
	var row map[string]any
	if err := json.Unmarshal(encoded, &row); err != nil {
		t.Fatalf("decode settled inventory row: %v", err)
	}
	if row["settle_ms"] != float64(100) || row["samples"] != float64(6) {
		t.Fatalf("FAILED PREDICATE [inventory.json-settled-evidence]: row=%s", encoded)
	}
}

// This real process-table rail must run outside sandboxes that deny OS inventory.
// case: S-237.23
func TestProcessInventoryDuringRealForkExecExitStorm(t *testing.T) {
	directory := t.TempDir()
	token := "x53-storm-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	stop := make(chan struct{})
	firstReady := make(chan struct{})
	firstRelease := make(chan struct{})
	var releaseFirst sync.Once
	var lock sync.RWMutex
	identities := make(map[int]string)
	var storm sync.WaitGroup
	storm.Add(1)
	go func() {
		defer storm.Done()
		for iteration := 0; ; iteration++ {
			select {
			case <-stop:
				return
			default:
			}
			release := filepath.Join(directory, fmt.Sprintf("release-%d", iteration))
			child := exec.Command("/bin/sh", "-c",
				`while [ ! -e "$1" ]; do :; done; exec /usr/bin/true "$2"`,
				"x53-inventory-storm-child", release, token)
			if err := child.Start(); err != nil {
				t.Errorf("start test-owned storm child: %v", err)
				return
			}
			identity, alive, err := ProcessIdentity(child.Process.Pid)
			if err != nil || !alive {
				_ = child.Process.Kill()
				_ = child.Wait()
				t.Errorf("record test-owned storm child identity pid=%d: identity=%q alive=%t err=%v",
					child.Process.Pid, identity, alive, err)
				return
			}
			lock.Lock()
			identities[child.Process.Pid] = identity
			lock.Unlock()
			if iteration == 0 {
				close(firstReady)
				<-firstRelease
			} else {
				time.Sleep(5 * time.Millisecond)
			}
			if err := os.WriteFile(release, nil, 0o600); err != nil {
				_ = child.Process.Kill()
				_ = child.Wait()
				t.Errorf("release test-owned storm child: %v", err)
				return
			}
			if err := child.Wait(); err != nil {
				t.Errorf("wait test-owned storm child: %v", err)
				return
			}
		}
	}()
	t.Cleanup(func() {
		releaseFirst.Do(func() { close(firstRelease) })
		close(stop)
		storm.Wait()
	})

	select {
	case <-firstReady:
	case <-time.After(testdeadline.Budget(t)):
		t.Fatal("real fork/exec/exit storm did not start its first child")
	}
	observedStormRows := 0
	for iteration := 0; iteration < 20; iteration++ {
		entries, err := ProcessInventory()
		if err != nil {
			t.Fatalf("inventory during real fork/exec/exit storm: %v", err)
		}
		lock.RLock()
		for _, entry := range entries {
			if identity, isStormChild := identities[entry.PID]; isStormChild && entry.Identity == identity {
				observedStormRows++
				if entry.Unverified || entry.ObservationError != "" || entry.ArgvError != "" || len(entry.Argv) == 0 {
					lock.RUnlock()
					t.Fatalf("FAILED PREDICATE [inventory.storm.no-transient-unverified]: real storm child PID %d did not resolve to readable argv: %+v",
						entry.PID, entry)
				}
			}
		}
		lock.RUnlock()
		if iteration == 0 {
			releaseFirst.Do(func() { close(firstRelease) })
		}
	}
	if observedStormRows == 0 {
		t.Fatalf("FAILED PREDICATE [inventory.storm.overlaps-inventory]: no test-owned child appeared in 20 process-table snapshots")
	}
}

func TestInventoryDoesNotDeepReadForeignUIDArguments(t *testing.T) {
	process := Process{PID: 813, PPID: 1, Identity: "813:started", uid: 0}
	entry, include := inventoryEntry(process, 501, func(int) ([]string, error) {
		return nil, errors.New("foreign process argv should not be read")
	}, func(int) (string, bool, error) {
		return "", false, errors.New("foreign process identity should not be read")
	})
	if !include || entry.Unverified || entry.ArgvError == "" || entry.UID != 0 {
		t.Fatalf("foreign uid row = %+v, included=%t; want visible but out-of-scope argv row", entry, include)
	}
}
