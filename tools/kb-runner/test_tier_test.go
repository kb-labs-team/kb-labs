package main

import (
	"fmt"
	"os"
	"testing"
)

type runnerTestTier uint8

const (
	runnerTestTierDefault runnerTestTier = iota
	runnerTestTierExhaustive
)

func (tier runnerTestTier) String() string {
	if tier == runnerTestTierExhaustive {
		return "exhaustive"
	}
	return "class-reduced"
}

// testTier is the single owner of the package's optional exhaustive test tier.
func testTier() runnerTestTier {
	switch os.Getenv("KB_RUNNER_TEST_TIER") {
	case "", "default":
		return runnerTestTierDefault
	case "T3", "T4":
		return runnerTestTierExhaustive
	default:
		panic(fmt.Sprintf("invalid KB_RUNNER_TEST_TIER %q: use default, T3, or T4", os.Getenv("KB_RUNNER_TEST_TIER")))
	}
}

func TestRunnerTestTierSelectsExhaustiveOnlyExplicitly(t *testing.T) {
	t.Setenv("KB_RUNNER_TEST_TIER", "")
	if got := testTier(); got != runnerTestTierDefault {
		t.Fatalf("default tier=%v, want class-reduced", got)
	}
	for _, tier := range []string{"T3", "T4"} {
		t.Setenv("KB_RUNNER_TEST_TIER", tier)
		if got := testTier(); got != runnerTestTierExhaustive {
			t.Fatalf("tier %s=%v, want exhaustive", tier, got)
		}
	}
}

func TestLifecycleCrashSelectionUsesObservedClassesAndLastTransitionWrite(t *testing.T) {
	scenario := lifecycleCrashScenario{name: "fixture-transition"}
	writes := []observedDurableWrite{
		{Ordinal: 1, Handler: "AtomicWrite", Transition: scenario.name, Kind: "atomic", PathClass: ".json"},
		{Ordinal: 2, Handler: "AtomicWrite", Transition: scenario.name, Kind: "atomic", PathClass: ".json"},
		{Ordinal: 3, Handler: "Append", Transition: scenario.name, Kind: "append", PathClass: ".log"},
		{Ordinal: 4, Handler: "AtomicWrite", Transition: scenario.name, Kind: "atomic", PathClass: ".json"},
	}
	selected, classes := lifecycleCrashOrdinals(t, scenario, writes, runnerTestTierDefault)
	if classes != 2 {
		t.Fatalf("observed classes=%d, want 2", classes)
	}
	if want := []int{1, 3, 4}; !equalInts(selected, want) {
		t.Fatalf("class-reduced ordinals=%v, want %v", selected, want)
	}
	exhaustive, exhaustiveClasses := lifecycleCrashOrdinals(t, scenario, writes, runnerTestTierExhaustive)
	if exhaustiveClasses != classes || !equalInts(exhaustive, []int{1, 2, 3, 4}) {
		t.Fatalf("exhaustive ordinals=%v classes=%d, want all writes and %d classes", exhaustive, exhaustiveClasses, classes)
	}
}

func equalInts(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
