package cmd

import (
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/workspace"
)

// TestFailureTailShowsAssertionAtEnd is the regression test for the devkit
// runner output fix: a failed test task's stderr starts with setup noise (log
// lines) while the actual assertion is printed to STDOUT at the END. The old
// behaviour printed the FIRST lines of stderr only, hiding the real failure.
// failureTail must surface the tail of the combined streams instead.
func TestFailureTailShowsAssertionAtEnd(t *testing.T) {
	stderr := "[ERROR] Skipped manifest patch\n[WARN] cache miss\n[INFO] booting runner"
	stdout := "RUN src/foo.test.ts\n× foo > bar\n  → expected 4 to be 5"

	lines, hidden := failureTail(stdout, stderr, 50)
	joined := strings.Join(lines, "\n")

	if !strings.Contains(joined, "expected 4 to be 5") {
		t.Errorf("tail must contain the assertion; got:\n%s", joined)
	}
	if hidden != 0 {
		t.Errorf("hidden = %d, want 0 (everything fits in 50 lines)", hidden)
	}
	// stdout must come before stderr so the runner summary leads.
	if i, j := strings.Index(joined, "× foo > bar"), strings.Index(joined, "[ERROR]"); i == -1 || j == -1 || i > j {
		t.Errorf("stdout should precede stderr; got:\n%s", joined)
	}
}

// TestFailureTailTruncatesToLimit verifies that only the last `limit` lines are
// returned and `hidden` reports the count dropped from the top.
func TestFailureTailTruncatesToLimit(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 100; i++ {
		b.WriteString("line")
		b.WriteByte('\n')
	}
	// 100 identical lines; make the last one distinguishable.
	stdout := b.String() + "FINAL-ASSERTION"

	lines, hidden := failureTail(stdout, "", 10)
	if len(lines) != 10 {
		t.Fatalf("len(lines) = %d, want 10", len(lines))
	}
	if lines[len(lines)-1] != "FINAL-ASSERTION" {
		t.Errorf("last line = %q, want FINAL-ASSERTION", lines[len(lines)-1])
	}
	if hidden != 91 { // 101 total lines - 10 shown
		t.Errorf("hidden = %d, want 91", hidden)
	}
}

// TestFailureTailUnlimited verifies limit <= 0 returns everything with nothing hidden.
func TestFailureTailUnlimited(t *testing.T) {
	stdout := "a\nb\nc\nd\ne"
	lines, hidden := failureTail(stdout, "", 0)
	if len(lines) != 5 || hidden != 0 {
		t.Errorf("got %d lines, hidden=%d; want 5 lines, hidden=0", len(lines), hidden)
	}
}

// TestFailureTailEmpty verifies empty input yields no lines.
func TestFailureTailEmpty(t *testing.T) {
	lines, hidden := failureTail("", "", 50)
	if len(lines) != 0 || hidden != 0 {
		t.Errorf("got %d lines, hidden=%d; want 0,0", len(lines), hidden)
	}
}

// A hosted CI job has no runner disk to inspect afterwards, so a failed task
// must print its whole log there. CI=true is the standard hosted-CI marker.
func TestFailLineLimitIsUnlimitedInCI(t *testing.T) {
	t.Setenv("KB_DEVKIT_FAIL_LINES", "")
	t.Setenv("CI", "true")
	if got := failLineLimit(); got != 0 {
		t.Errorf("failLineLimit() in CI = %d, want 0 (unlimited)", got)
	}
}

func TestFailLineLimitDefaultsToTailOutsideCI(t *testing.T) {
	t.Setenv("KB_DEVKIT_FAIL_LINES", "")
	t.Setenv("CI", "")
	if got := failLineLimit(); got != 50 {
		t.Errorf("failLineLimit() outside CI = %d, want 50", got)
	}
}

func TestFailLineLimitExplicitValueBeatsCI(t *testing.T) {
	t.Setenv("CI", "true")
	t.Setenv("KB_DEVKIT_FAIL_LINES", "7")
	if got := failLineLimit(); got != 7 {
		t.Errorf("failLineLimit() = %d, want the explicit 7", got)
	}
}

// The two lanes partition the workspace: nothing is in both, nothing is
// dropped, and membership comes from the package's declared release lane.
func TestSelectReleaseLanePartitionsWorkspace(t *testing.T) {
	pkgs := []workspace.Package{
		{Name: "tool", ReleaseLane: "internal-tool"},
		{Name: "shipped-go"},
		{Name: "shipped-ts"},
	}
	internal, err := selectReleaseLane(pkgs, "internal-tool")
	if err != nil {
		t.Fatal(err)
	}
	shipped, err := selectReleaseLane(pkgs, "shipped")
	if err != nil {
		t.Fatal(err)
	}
	if len(internal) != 1 || internal[0].Name != "tool" {
		t.Errorf("internal-tool lane = %v, want [tool]", internal)
	}
	if len(shipped) != 2 || shipped[0].Name != "shipped-go" || shipped[1].Name != "shipped-ts" {
		t.Errorf("shipped lane = %v, want [shipped-go shipped-ts]", shipped)
	}
	if _, err := selectReleaseLane(pkgs, "bogus"); err == nil {
		t.Error("unknown lane must be rejected")
	}
	if all, err := selectReleaseLane(pkgs, ""); err != nil || len(all) != 3 {
		t.Errorf("empty lane = %v, %v; want all 3 packages", all, err)
	}
}
