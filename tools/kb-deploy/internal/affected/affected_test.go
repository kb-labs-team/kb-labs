package affected

import (
	"testing"

	"github.com/kb-labs/kb-deploy/internal/config"
	"github.com/kb-labs/kb-deploy/internal/state"
)

func TestMatches(t *testing.T) {
	cases := []struct {
		patterns []string
		files    []string
		want     bool
	}{
		{[]string{"sites/web/**"}, []string{"sites/web/apps/web/page.tsx"}, true},
		{[]string{"sites/web/**"}, []string{"plugins/agents/src/core/index.ts"}, false},
		{[]string{"sites/web/apps/docs/**"}, []string{"sites/web/apps/web/page.tsx"}, false},
		{[]string{"sites/web/apps/docs/**"}, []string{"sites/web/apps/docs/content/index.mdx"}, true},
		// Multiple patterns — any match wins.
		{[]string{"a/**", "b/**"}, []string{"b/x.go"}, true},
		// Multiple files — any match wins.
		{[]string{"a/**"}, []string{"b/x.go", "a/y.go"}, true},
		// Empty files.
		{[]string{"sites/**"}, []string{}, false},
		// Empty patterns.
		{[]string{}, []string{"sites/x.ts"}, false},
	}
	for _, c := range cases {
		got := matches(c.patterns, c.files)
		if got != c.want {
			t.Errorf("matches(%v, %v) = %v, want %v", c.patterns, c.files, got, c.want)
		}
	}
}

func TestDetectFallsBackOnNoParent(t *testing.T) {
	// Use /tmp as repoRoot — not a git repo, so git diff will fail.
	// Expect all targets returned regardless of state.
	cfg := &config.Config{
		Targets: map[string]config.Target{
			"a": {Watch: []string{"a/**"}},
			"b": {Watch: []string{"b/**"}},
		},
	}
	s := &state.State{Targets: map[string]state.TargetState{
		"a": {SHA: "abc", Status: "success"},
		"b": {SHA: "def", Status: "success"},
	}}
	got, err := Detect("/tmp", cfg, s)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 targets on fallback, got %d: %v", len(got), got)
	}
}

func TestDetectFromChangesIncludesFailedTarget(t *testing.T) {
	cfg := &config.Config{
		Targets: map[string]config.Target{
			"web": {Watch: []string{"sites/web/**"}},
		},
	}
	s := &state.State{Targets: map[string]state.TargetState{
		"web": {SHA: "abc", Status: "failed"},
	}}
	// No file changes — target included because last deploy failed.
	got := detectFromChanges(nil, cfg, s)
	if len(got) != 1 || got[0] != "web" {
		t.Fatalf("detectFromChanges = %v, want [web] (last deploy failed)", got)
	}
}

func TestDetectFromChangesIncludesNeverDeployedTarget(t *testing.T) {
	cfg := &config.Config{
		Targets: map[string]config.Target{
			"web": {Watch: []string{"sites/web/**"}},
		},
	}
	s := &state.State{Targets: map[string]state.TargetState{}}
	// No file changes, no state (never deployed) — must be included.
	got := detectFromChanges(nil, cfg, s)
	if len(got) != 1 || got[0] != "web" {
		t.Fatalf("detectFromChanges = %v, want [web] (never deployed)", got)
	}
}

func TestDetectFromChangesExcludesSuccessfulTargetNoChanges(t *testing.T) {
	cfg := &config.Config{
		Targets: map[string]config.Target{
			"web": {Watch: []string{"sites/web/**"}},
		},
	}
	s := &state.State{Targets: map[string]state.TargetState{
		"web": {SHA: "abc", Status: "success"},
	}}
	got := detectFromChanges(nil, cfg, s)
	if len(got) != 0 {
		t.Fatalf("detectFromChanges = %v, want [] (success + no changes)", got)
	}
}

func TestDetectFromChangesIncludesChangedSuccessfulTarget(t *testing.T) {
	cfg := &config.Config{
		Targets: map[string]config.Target{
			"web": {Watch: []string{"sites/web/**"}},
		},
	}
	s := &state.State{Targets: map[string]state.TargetState{
		"web": {SHA: "abc", Status: "success"},
	}}
	got := detectFromChanges([]string{"sites/web/page.tsx"}, cfg, s)
	if len(got) != 1 || got[0] != "web" {
		t.Fatalf("detectFromChanges = %v, want [web] (files changed)", got)
	}
}
