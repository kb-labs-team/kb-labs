package journey

import (
	"reflect"
	"testing"
)

// case: S-262.20
func TestBuildPlanPartitionsCompleteRunnableSelectionAndOwnerPrerequisites(t *testing.T) {
	selection := Selection{
		Schema:           SelectionSchema,
		SourceSHA:        "0123456789abcdef0123456789abcdef01234567",
		MandatoryStepIDs: []string{"local:S-181.1", "local:S-181.2", "local:setup-local", "secured:S-181.1", "secured:S-181.2", "secured:setup-secured"},
		Steps: []RunnableStep{
			{ID: "S-181.1", Mode: "local", Area: "platform-core", Runner: "service-local-explore", Weight: 9, Mandatory: true, Requires: []string{"setup-local"}},
			{ID: "setup-local", Mode: "local", Area: "platform-core", Runner: "service-local-explore", Mandatory: true},
			{ID: "S-181.2", Mode: "local", Area: "platform-core", Runner: "service-local-explore", Weight: 2, Mandatory: true},
			{ID: "S-181.1", Mode: "secured", Area: "platform-core", Runner: "service-secured-explore", Weight: 9, Mandatory: true, Requires: []string{"setup-secured"}},
			{ID: "setup-secured", Mode: "secured", Area: "platform-core", Runner: "service-secured-explore", Mandatory: true},
			{ID: "S-181.2", Mode: "secured", Area: "platform-core", Runner: "service-secured-explore", Weight: 2, Mandatory: true},
		},
	}

	plan, err := BuildPlan(selection, 2)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SourceSHA != selection.SourceSHA || plan.ID == "" || len(plan.Shards) != 4 {
		t.Fatalf("plan identity or shard count = (%q, %q, %d)", plan.ID, plan.SourceSHA, len(plan.Shards))
	}
	if len(plan.FullSelection) != len(selection.Steps) {
		t.Fatalf("full selection length = %d, want all %d runnable steps", len(plan.FullSelection), len(selection.Steps))
	}

	direct := map[string]int{}
	for _, shard := range plan.Shards {
		for _, id := range shard.DirectStepIDs {
			direct[shard.Mode+":"+id]++
		}
		for _, step := range shard.Steps {
			if shard.Mode == "local" && contains(shard.DirectStepIDs, "S-181.1") && step.ID == "setup-local" && step.Direct {
				t.Fatal("owner prerequisite should be included in the dependent shard's closure, not as a second direct root")
			}
			if shard.Mode == "secured" && contains(shard.DirectStepIDs, "S-181.1") && step.ID == "setup-secured" && step.Direct {
				t.Fatal("secured prerequisite should be closure-only in the dependent shard")
			}
		}
	}
	for _, step := range selection.Steps {
		if direct[step.Mode+":"+step.ID] != 1 {
			t.Errorf("direct assignment for %s:%s = %d, want exactly once", step.Mode, step.ID, direct[step.Mode+":"+step.ID])
		}
	}
	if plan.Shards[0].ID == plan.Shards[1].ID || plan.Shards[0].ID == "" {
		t.Fatal("shard identities must be non-empty and unique")
	}
	again, err := BuildPlan(selection, 2)
	if err != nil || !reflect.DeepEqual(plan, again) {
		t.Fatalf("plan is not deterministic: err=%v", err)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestBuildPlanRejectsInvalidIdentityAndOwnerlessDependency(t *testing.T) {
	base := Selection{Schema: SelectionSchema, SourceSHA: "0123456789abcdef0123456789abcdef01234567", MandatoryStepIDs: []string{"local:claim"}, Steps: []RunnableStep{
		{ID: "claim", Mode: "local", Area: "cli", Runner: "agent:commit", Requires: []string{"other"}},
		{ID: "other", Mode: "local", Area: "cli", Runner: "service-local-explore"},
	}}
	if _, err := BuildPlan(base, 2); err == nil {
		t.Fatal("cross-owner prerequisite should fail closed")
	}
	base.Steps[0].Requires = nil
	base.SourceSHA = "not-a-sha"
	if _, err := BuildPlan(base, 2); err == nil {
		t.Fatal("invalid source SHA should fail closed")
	}
}

func TestBuildPlanFailsWhenActiveMandatoryStepWasDroppedFromRunnableSelection(t *testing.T) {
	selection := Selection{Schema: SelectionSchema, SourceSHA: "0123456789abcdef0123456789abcdef01234567",
		MandatoryStepIDs: []string{"local:required-step"}, Steps: []RunnableStep{
			{ID: "present", Mode: "local", Area: "cli", Runner: "agent:commit"},
		}}
	if _, err := BuildPlan(selection, 1); err == nil {
		t.Fatal("plan passed after dropping an active mandatory step")
	}
}
