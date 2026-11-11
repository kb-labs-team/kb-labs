package netoffset

import (
	"fmt"
	"net"
	"path/filepath"
	"testing"
)

func TestDeriveOffset_deterministic(t *testing.T) {
	a := DeriveOffset("dit-1")
	b := DeriveOffset("dit-1")
	if a != b {
		t.Fatalf("DeriveOffset(%q) not deterministic: %d != %d", "dit-1", a, b)
	}
}

func TestDeriveOffset_spread(t *testing.T) {
	aliases := []string{"dit-1", "dit-2", "figma-map", "kb-labs", "dit-3", "dit-4"}
	seen := make(map[int]string)
	collisions := 0
	for _, a := range aliases {
		off := DeriveOffset(a)
		if off < baseOffset || off >= baseOffset+offsetRange {
			t.Errorf("DeriveOffset(%q) = %d out of range [%d, %d)", a, off, baseOffset, baseOffset+offsetRange)
		}
		if prev, ok := seen[off]; ok {
			collisions++
			t.Logf("offset collision: %q and %q both -> %d", prev, a, off)
		}
		seen[off] = a
	}
	if collisions == len(aliases) {
		t.Fatal("every alias collided — hash is not spreading values at all")
	}
}

func TestResolve_usesDerivedOffsetWhenFree(t *testing.T) {
	pidDir := filepath.Join(t.TempDir(), ".kb", "tmp")
	alias := "free-alias"

	off, err := Resolve(alias, pidDir, func(offset int) []int {
		return []int{5050 + offset, 7778 + offset}
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if off != DeriveOffset(alias) {
		t.Errorf("Resolve = %d, want derived offset %d (ports were free)", off, DeriveOffset(alias))
	}
}

func TestResolve_stepsPastOccupiedPort(t *testing.T) {
	pidDir := filepath.Join(t.TempDir(), ".kb", "tmp")
	alias := "occupied-alias"

	derived := DeriveOffset(alias)
	// Reserve distinct real TCP ports for each candidate. Reusing one
	// unoccupied adjacent port for all 49 retries made unrelated CI listeners
	// look like a broken probe for every offset.
	candidatePorts := make([]int, maxAttempts)
	var occupied net.Listener
	for index := range candidatePorts {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Skipf("cannot bind a test listener: %v", err)
		}
		candidatePorts[index] = listener.Addr().(*net.TCPAddr).Port
		if index == 0 {
			occupied = listener
			continue
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	}
	defer occupied.Close()

	off, err := Resolve(alias, pidDir, func(offset int) []int {
		attempt := (offset - derived) / offsetStep
		return []int{candidatePorts[attempt]}
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if off != derived+offsetStep {
		t.Fatalf("Resolve returned the occupied derived offset %d, expected it to step past it", derived)
	}
}

func TestResolve_cachesAcrossRuns(t *testing.T) {
	pidDir := filepath.Join(t.TempDir(), ".kb", "tmp")
	alias := "cached-alias"
	ports := func(offset int) []int { return []int{6000 + offset} }

	first, err := Resolve(alias, pidDir, ports)
	if err != nil {
		t.Fatalf("Resolve (first): %v", err)
	}
	second, err := Resolve(alias, pidDir, ports)
	if err != nil {
		t.Fatalf("Resolve (second): %v", err)
	}
	if first != second {
		t.Errorf("offset changed between runs with no port conflict: %d != %d", first, second)
	}
}

// TestResolve_trustsCacheEvenWhenPortsNowOccupied reproduces the multi-project
// switch/status bug: an alias's own services are actually running (holding
// the cached offset's ports), and a second command (e.g. `status`) resolves
// the same alias again. Resolve must return the same cached offset rather
// than treating "port occupied by our own already-started service" as a
// collision and silently reassigning a different one — which would leave
// kb-dev probing health on ports nothing is listening on while the real
// service keeps running on the cached ports untouched.
func TestResolve_trustsCacheEvenWhenPortsNowOccupied(t *testing.T) {
	pidDir := filepath.Join(t.TempDir(), ".kb", "tmp")
	alias := "already-running-alias"

	ports := func(offset int) []int { return []int{6100 + offset} }

	first, err := Resolve(alias, pidDir, ports)
	if err != nil {
		t.Fatalf("Resolve (first): %v", err)
	}

	// Simulate the alias's own service now actually listening on the
	// resolved port (as it would be, between `switch` and any later
	// `status`/reconcile call).
	ln, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", ports(first)[0]))
	if err != nil {
		t.Skipf("cannot bind a test listener: %v", err)
	}
	defer ln.Close()

	second, err := Resolve(alias, pidDir, ports)
	if err != nil {
		t.Fatalf("Resolve (second): %v", err)
	}
	if second != first {
		t.Fatalf("Resolve reassigned offset %d -> %d because its own service's port looked occupied — "+
			"this is exactly the multi-project switch/status bug", first, second)
	}
}
