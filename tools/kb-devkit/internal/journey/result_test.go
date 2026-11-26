package journey

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// case: S-262.20
func TestRecordAndFinalizeRequireRunnerBoundReceipt(t *testing.T) {
	plan := makePlan(t, "local", "secured")
	root := t.TempDir()
	var dirs []string
	for _, shard := range plan.Shards {
		dir := filepath.Join(root, shard.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		lease, err := BeginShard(plan, shard.ID)
		if err != nil {
			t.Fatal(err)
		}
		writeRunnerReport(t, dir, lease)
		if err := RecordShardResult(plan, lease, dir, []string{"journey.json"}); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, dir)
	}
	result, err := Finalize(plan, dirs, func(mode string, reports []string) error {
		if len(reports) != 1 {
			t.Fatalf("mode %s got reports %v", mode, reports)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "passed" || len(result.Shards) != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestRecordRejectsForeignAttemptAndMissingOrFailedSteps(t *testing.T) {
	plan := makePlan(t, "local")
	lease, err := BeginShard(plan, plan.Shards[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	altered := lease
	altered.ShardID = "foreign"
	if err := validateLeaseAgainstPlan(plan, altered); err == nil {
		t.Fatal("foreign shard lease accepted")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "journey.json"), []byte(`{"execution":{},"steps":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordShardResult(plan, lease, dir, []string{"journey.json"}); err == nil {
		t.Fatal("report without matching receipt and PASS rows accepted")
	}
}

func TestFinalizeRejectsReportTamperingAfterRecording(t *testing.T) {
	plan := makePlan(t, "local")
	var dirs []string
	for _, shard := range plan.Shards {
		dir := filepath.Join(t.TempDir(), shard.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		lease, err := BeginShard(plan, shard.ID)
		if err != nil {
			t.Fatal(err)
		}
		writeRunnerReport(t, dir, lease)
		if err := RecordShardResult(plan, lease, dir, []string{"journey.json"}); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, dir)
	}
	if err := os.WriteFile(filepath.Join(dirs[0], "journey.json"), []byte(`{"steps":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Finalize(plan, dirs, func(string, []string) error { t.Fatal("coverage must not run for tampered report"); return nil }); err == nil {
		t.Fatal("tampered report accepted")
	}
}

func makePlan(t *testing.T, modes ...string) Plan {
	t.Helper()
	steps := make([]RunnableStep, 0, len(modes)+1)
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
	plan, err := BuildPlan(selectionFixture(steps...), 2)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func writeRunnerReport(t *testing.T, directory string, lease ShardLease) {
	t.Helper()
	receipt := map[string]any{"schema": RunnerReceiptSchema, "planId": lease.PlanID, "sourceSHA": lease.SourceSHA,
		"shardId": lease.ShardID, "attemptId": lease.AttemptID, "mode": lease.Mode, "runner": lease.Runner,
		"claimIds": lease.ClaimIDs, "directStepIds": lease.DirectStepIDs}
	steps := make([]map[string]string, 0, len(lease.SelectedStepNames))
	for _, name := range lease.SelectedStepNames {
		steps = append(steps, map[string]string{"name": name, "status": "PASS"})
	}
	payload, err := json.Marshal(map[string]any{"execution": receipt, "steps": steps})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "journey.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
}
