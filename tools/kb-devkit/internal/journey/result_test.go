package journey

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// case: S-262.20
func TestFinalizeRequiresExactlyOneMatchingShardAndRuntimeCoverage(t *testing.T) {
	plan := makePlan(t, "local", "secured")
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &plan); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	local := writeResultDir(t, root, "local", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	secured := writeResultDir(t, root, "secured", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[1].ID, Mode: "secured", Status: "passed", Reports: []string{"journey.json"}})

	coverageCalls := map[string]int{}
	result, err := Finalize(plan, []string{local, secured}, func(mode string, reports []string) error {
		coverageCalls[mode]++
		if len(reports) != 1 || filepath.Base(reports[0]) != "journey.json" {
			t.Fatalf("coverage received reports %v", reports)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "passed" || coverageCalls["local"] != 1 || coverageCalls["secured"] != 1 {
		t.Fatalf("result=%+v coverage calls=%v", result, coverageCalls)
	}
}

func TestFinalizeFailsClosedOnMissingDuplicateForeignAndStaleShards(t *testing.T) {
	plan := makePlan(t, "local", "local")
	root := t.TempDir()
	a := writeResultDir(t, root, "a", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	b := writeResultDir(t, root, "b", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[1].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	secure := writeResultDir(t, root, "secure", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[2].ID, Mode: "secured", Status: "passed", Reports: []string{"journey.json"}})
	duplicate := writeResultDir(t, root, "duplicate", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	foreign := writeResultDir(t, root, "foreign", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: "other", Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	stale := writeResultDir(t, root, "stale", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})

	for name, dirs := range map[string][]string{
		"missing":   {a},
		"duplicate": {a, duplicate, secure},
		"foreign":   {a, foreign, secure},
		"stale":     {stale, b, secure},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Finalize(plan, dirs, func(string, []string) error { t.Fatal("coverage must not run for invalid shard evidence"); return nil }); err == nil {
				t.Fatalf("Finalize(%s) unexpectedly passed", name)
			}
		})
	}
}

func TestFinalizeFailsWhenRuntimeCoverageFailsOrReportEscapesShardDirectory(t *testing.T) {
	plan := makePlan(t, "local")
	root := t.TempDir()
	valid := writeResultDir(t, root, "valid", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"journey.json"}})
	secured := writeResultDir(t, root, "secured", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[1].ID, Mode: "secured", Status: "passed", Reports: []string{"journey.json"}})
	if _, err := Finalize(plan, []string{valid, secured}, func(string, []string) error { return fmt.Errorf("release claim incomplete") }); err == nil {
		t.Fatal("runtime coverage failure must fail finalization")
	}
	unsafe := writeResultDir(t, root, "unsafe", ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, ShardID: plan.Shards[0].ID, Mode: "local", Status: "passed", Reports: []string{"../valid/journey.json"}})
	if _, err := Finalize(plan, []string{unsafe, secured}, func(string, []string) error { t.Fatal("coverage must not run for escaped report path"); return nil }); err == nil {
		t.Fatal("report outside evidence directory must fail closed")
	}
	tampered := plan
	tampered.FullSelection = append([]RunnableStep(nil), plan.FullSelection...)
	tampered.FullSelection[0].Area = "different-area"
	if _, err := Finalize(tampered, []string{valid}, func(string, []string) error { t.Fatal("coverage must not run for a modified plan"); return nil }); err == nil {
		t.Fatal("plan content that no longer matches its identity must fail")
	}
}

func TestRecordShardResultOnlyRecordsPlannedShardAndDoesNotOverwrite(t *testing.T) {
	plan := makePlan(t, "local")
	directory := filepath.Join(t.TempDir(), "shard")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "journey.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordShardResult(plan, "foreign", "passed", directory, []string{"journey.json"}); err == nil {
		t.Fatal("foreign shard must not be recordable")
	}
	if err := RecordShardResult(plan, plan.Shards[0].ID, "passed", directory, []string{"journey.json"}); err != nil {
		t.Fatal(err)
	}
	if err := RecordShardResult(plan, plan.Shards[0].ID, "passed", directory, []string{"journey.json"}); err == nil {
		t.Fatal("recording must not overwrite prior evidence")
	}
}

func makePlan(t *testing.T, modes ...string) Plan {
	t.Helper()
	steps := make([]RunnableStep, 0, len(modes))
	hasSecured := false
	for index, mode := range modes {
		id := fmt.Sprintf("step-%02d", index)
		runner := "service-local:explore"
		if mode == "secured" {
			runner = "service-secured:explore"
			hasSecured = true
		}
		steps = append(steps, RunnableStep{ID: runner + "|step:" + id, Name: id, Kind: "step", Mode: mode, Area: "platform-core", Runner: runner, Mandatory: true})
	}
	if !hasSecured {
		steps = append(steps, RunnableStep{ID: "service-secured:explore|step:required-secured", Name: "required-secured", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true})
	}
	selection := selectionFixture(steps...)
	plan, err := BuildPlan(selection, 2)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func writeResultDir(t *testing.T, root, name string, result ShardResult) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "journey.json"), []byte(`{"schema":"test"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteShardResult(dir, result); err != nil {
		t.Fatal(err)
	}
	return dir
}
