package journey

import (
	"reflect"
	"sort"
	"testing"
)

// case: S-262.20
func TestBuildPlanPartitionsCompleteRunnableSelectionAndOwnerPrerequisites(t *testing.T) {
	selection := selectionFixture(
		RunnableStep{ID: "service-local:explore|step:S-181.1", Name: "S-181.1", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Weight: 9, Mandatory: true, Requires: []string{"service-local:explore|step:setup-local"}},
		RunnableStep{ID: "service-local:explore|step:setup-local", Name: "setup-local", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
		RunnableStep{ID: "service-local:explore|step:S-181.2", Name: "S-181.2", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Weight: 2, Mandatory: true},
		RunnableStep{ID: "service-secured:explore|step:S-181.1", Name: "S-181.1", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Weight: 9, Mandatory: true, Requires: []string{"service-secured:explore|step:setup-secured"}},
		RunnableStep{ID: "service-secured:explore|step:setup-secured", Name: "setup-secured", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true},
		RunnableStep{ID: "service-secured:explore|step:S-181.2", Name: "S-181.2", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Weight: 2, Mandatory: true},
	)

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
		if len(shard.Domains) != 1 {
			t.Fatalf("shard mixed domains: %+v", shard)
		}
		owners := map[string]bool{}
		for _, step := range shard.Steps {
			owners[step.Runner] = true
			if shard.Mode == "local" && contains(shard.DirectStepIDs, "service-local:explore|step:S-181.1") && step.Name == "setup-local" && step.Direct {
				t.Fatal("owner prerequisite should be included in the dependent shard's closure, not as a second direct root")
			}
			if shard.Mode == "secured" && contains(shard.DirectStepIDs, "service-secured:explore|step:S-181.1") && step.Name == "setup-secured" && step.Direct {
				t.Fatal("secured prerequisite should be closure-only in the dependent shard")
			}
		}
		if len(owners) != 1 {
			t.Fatalf("shard mixed runner owners: %+v", shard)
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
	base := selectionFixture(
		RunnableStep{ID: "service-local:explore|step:claim", Name: "claim", Kind: "step", Mode: "local", Area: "cli", Runner: "service-local:explore", Mandatory: true, Requires: []string{"agent:commit|step:other"}},
		RunnableStep{ID: "agent:commit|step:other", Name: "other", Kind: "step", Mode: "local", Area: "cli", Runner: "agent:commit", Mandatory: true},
		RunnableStep{ID: "service-secured:explore|step:secure", Name: "secure", Kind: "step", Mode: "secured", Area: "cli", Runner: "service-secured:explore", Mandatory: true},
	)
	if _, err := BuildPlan(base, 2); err == nil {
		t.Fatal("cross-owner prerequisite should fail closed")
	}
	base.Steps[0].Requires = []string{"agent:commit|step:other"}
	base.SourceSHA = "not-a-sha"
	if _, err := BuildPlan(base, 2); err == nil {
		t.Fatal("invalid source SHA should fail closed")
	}
}

func TestBuildPlanFailsWhenActiveMandatoryStepWasDroppedFromRunnableSelection(t *testing.T) {
	selection := selectionFixture(
		RunnableStep{ID: "service-local:explore|step:present", Name: "present", Kind: "step", Mode: "local", Area: "cli", Runner: "service-local:explore", Mandatory: true},
		RunnableStep{ID: "service-secured:explore|step:secure", Name: "secure", Kind: "step", Mode: "secured", Area: "cli", Runner: "service-secured:explore", Mandatory: true},
	)
	selection.MandatoryStepIDs = append(selection.MandatoryStepIDs, "local:service-local:explore|step:required-step")
	if _, err := BuildPlan(selection, 1); err == nil {
		t.Fatal("plan passed after dropping an active mandatory step")
	}
}

// case: S-262.20
func TestBuildPlanKeepsDomainAndRunnerBoundariesAndRequiresBothModes(t *testing.T) {
	selection := selectionFixture(
		RunnableStep{ID: "service-local:explore|step:platform", Name: "platform", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
		RunnableStep{ID: "service-local:explore|step:market", Name: "market", Kind: "step", Mode: "local", Area: "marketplace", Runner: "service-local:explore", Mandatory: true},
		RunnableStep{ID: "service-secured:explore|step:platform-secured", Name: "platform-secured", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true},
		RunnableStep{ID: "agent-secured:commit|step:market-secured", Name: "market-secured", Kind: "step", Mode: "secured", Area: "marketplace", Runner: "agent-secured:commit", Mandatory: true},
	)
	plan, err := BuildPlan(selection, 4)
	if err != nil {
		t.Fatal(err)
	}
	for _, shard := range plan.Shards {
		if len(shard.Domains) != 1 {
			t.Fatalf("shard combines domains: %+v", shard)
		}
		for _, step := range shard.Steps {
			if step.Mode != shard.Mode || step.Runner != shard.Runners[0] {
				t.Fatalf("shard combines modes or runner owners: %+v", shard)
			}
		}
	}
	localOnly := selectionFixture(selection.Steps[0], selection.Steps[1])
	if _, err := BuildPlan(localOnly, 2); err == nil {
		t.Fatal("installer route without secured selection must fail closed")
	}
}

func selectionFixture(steps ...RunnableStep) Selection {
	selectors := map[string]bool{}
	mandatory := make([]string, 0, len(steps))
	for _, step := range steps {
		selectors[step.Runner] = true
		if step.Mandatory {
			mandatory = append(mandatory, step.Mode+":"+step.ID)
		}
	}
	selectorList := make([]string, 0, len(selectors))
	for selector := range selectors {
		selectorList = append(selectorList, selector)
	}
	sort.Strings(selectorList)
	sort.Strings(mandatory)
	return Selection{Schema: SelectionSchema, Producer: SelectionProducer, Policy: JourneyPolicy,
		SourceSHA: "0123456789abcdef0123456789abcdef01234567", RequiredModes: []string{"local", "secured"},
		Selectors: selectorList, MandatoryStepIDs: mandatory, Steps: steps}
}
