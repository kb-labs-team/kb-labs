package journey

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// case: S-262.20
func TestRecordAndFinalizeRequireRunnerBoundReceipt(t *testing.T) {
	plan := makePlan(t, "local", "secured")
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	var dirs []string
	for _, shard := range plan.Shards {
		dir := filepath.Join(root, shard.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		lease, err := PreparedLease(plan, prepared, shard.ID)
		if err != nil {
			t.Fatal(err)
		}
		writeRunnerReport(t, dir, lease)
		if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, dir)
	}
	result, err := Finalize(plan, prepared, dirs, func(mode string, reports []string) error {
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
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := PreparedLease(plan, prepared, plan.Shards[0].ID)
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
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err == nil {
		t.Fatal("report without matching receipt and PASS rows accepted")
	}
}

func TestRecordRejectsReportWithPassingPlannedRowsButFailingRunnerResult(t *testing.T) {
	plan := makePlan(t, "local")
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := PreparedLease(plan, prepared, plan.Shards[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writeRunnerReport(t, dir, lease)
	path := filepath.Join(dir, "journey.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var report map[string]any
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	report["status"] = "FAIL"
	data, err = json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err == nil {
		t.Fatal("failing runner report accepted despite passing owner row")
	}
}

func TestRecordRejectsReportFromPriorAttemptEvenWithFreshEvidenceDirectory(t *testing.T) {
	plan := makePlan(t, "local")
	shardID := plan.Shards[0].ID
	oldPrepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	oldLease, err := PreparedLease(plan, oldPrepared, shardID)
	if err != nil {
		t.Fatal(err)
	}
	newPrepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	newLease, err := PreparedLease(plan, newPrepared, shardID)
	if err != nil {
		t.Fatal(err)
	}
	if oldLease.AttemptID == newLease.AttemptID {
		t.Fatal("execution attempts must have unique IDs")
	}
	dir := t.TempDir()
	writeRunnerReport(t, dir, oldLease)
	if err := RecordShardResult(plan, oldPrepared, oldLease, dir, []string{"journey.json"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Finalize(plan, newPrepared, []string{dir}, func(string, []string) error {
		t.Fatal("coverage must not run for an old manifest/report pair")
		return nil
	}); err == nil {
		t.Fatal("old manifest and report pair accepted for a fresh prepared run")
	}
	if err := RecordShardResult(plan, newPrepared, newLease, dir, []string{"journey.json"}); err == nil {
		t.Fatal("stale report was accepted with a fresh lease and evidence directory")
	}
}

func TestEvidenceDistinguishesSameNameStepAndFlowOwners(t *testing.T) {
	local := []RunnableStep{
		{ID: "service-local:explore|step:shared owner", Name: "shared owner", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
		{ID: "service-local:explore|flow:shared owner", Name: "shared owner", Kind: "flow", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
	}
	secure := RunnableStep{ID: "service-secured:explore|step:secure owner", Name: "secure owner", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true}
	selection := selectionFixture(append(local, secure)...)
	plan, err := BuildPlan(selection, 1)
	if err != nil {
		t.Fatal(err)
	}
	var localShard *Shard
	for index := range plan.Shards {
		if plan.Shards[index].Mode == "local" {
			localShard = &plan.Shards[index]
			break
		}
	}
	if localShard == nil {
		t.Fatal("missing local shard")
	}
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := PreparedLease(plan, prepared, localShard.ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writeRunnerReport(t, dir, lease)
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err != nil {
		t.Fatal(err)
	}
}

func TestEvidenceRequiresLifecycleProofForPlannedStatePrerequisites(t *testing.T) {
	steps := []RunnableStep{
		{ID: "service-local:explore|step:check host", Name: "check host", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", States: []string{"host-running"}, Mandatory: true},
		{ID: "service-secured:explore|step:secure check", Name: "secure check", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true},
	}
	plan, err := BuildPlan(selectionFixture(steps...), 1)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	var shard Shard
	for _, item := range plan.Shards {
		if item.Mode == "local" {
			shard = item
			break
		}
	}
	lease, err := PreparedLease(plan, prepared, shard.ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writeRunnerReport(t, dir, lease)
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err != nil {
		t.Fatal(err)
	}
}

func TestEvidenceAcceptsRepeatedPassingLifecycleProbesForStatePrerequisite(t *testing.T) {
	steps := []RunnableStep{
		{ID: "service-local:explore|step:check host", Name: "check host", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", States: []string{"host-running"}, Mandatory: true},
		{ID: "service-secured:explore|step:secure check", Name: "secure check", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true},
	}
	plan, err := BuildPlan(selectionFixture(steps...), 1)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	var shard Shard
	for _, item := range plan.Shards {
		if item.Mode == "local" {
			shard = item
			break
		}
	}
	lease, err := PreparedLease(plan, prepared, shard.ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writeRunnerReport(t, dir, lease)
	path := filepath.Join(dir, "journey.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var report map[string]any
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	rows := report["steps"].([]any)
	for _, raw := range rows {
		row := raw.(map[string]any)
		if row["name"] == "state probe: host-running" {
			duplicate, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			var copied map[string]any
			if err := json.Unmarshal(duplicate, &copied); err != nil {
				t.Fatal(err)
			}
			report["steps"] = append(rows, copied)
			break
		}
	}
	data, err = json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err != nil {
		t.Fatalf("repeated passing lifecycle probes were rejected: %v", err)
	}
}

func TestRecordAggregatesOwnerRowsAcrossRunnerReports(t *testing.T) {
	steps := []RunnableStep{
		{ID: "service-local:explore|step:first", Name: "first", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
		{ID: "service-local:explore|step:second", Name: "second", Kind: "step", Mode: "local", Area: "platform-core", Runner: "service-local:explore", Mandatory: true},
		{ID: "service-secured:explore|step:secure", Name: "secure", Kind: "step", Mode: "secured", Area: "platform-core", Runner: "service-secured:explore", Mandatory: true},
	}
	plan, err := BuildPlan(selectionFixture(steps...), 1)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	var shard Shard
	for _, item := range plan.Shards {
		if item.Mode == "local" {
			shard = item
			break
		}
	}
	lease, err := PreparedLease(plan, prepared, shard.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(lease.Steps) != 2 {
		t.Fatalf("expected two local owners in shard: %+v", lease.Steps)
	}
	dir := t.TempDir()
	for index, step := range lease.Steps {
		payload := runnerReportPayload(t, lease, []ExecutionStep{step}, index == 0)
		name := fmt.Sprintf("report-%d.json", index)
		if err := os.WriteFile(filepath.Join(dir, name), payload, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecordShardResult(plan, prepared, lease, dir, []string{"report-0.json", "report-1.json"}); err != nil {
		t.Fatal(err)
	}
}

func TestFinalizeRejectsReportTamperingAfterRecording(t *testing.T) {
	plan := makePlan(t, "local")
	prepared, err := PrepareRun(plan)
	if err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, shard := range plan.Shards {
		dir := filepath.Join(t.TempDir(), shard.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		lease, err := PreparedLease(plan, prepared, shard.ID)
		if err != nil {
			t.Fatal(err)
		}
		writeRunnerReport(t, dir, lease)
		if err := RecordShardResult(plan, prepared, lease, dir, []string{"journey.json"}); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, dir)
	}
	if err := os.WriteFile(filepath.Join(dirs[0], "journey.json"), []byte(`{"steps":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Finalize(plan, prepared, dirs, func(string, []string) error { t.Fatal("coverage must not run for tampered report"); return nil }); err == nil {
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
	payload := runnerReportPayload(t, lease, lease.Steps, true)
	if err := os.WriteFile(filepath.Join(directory, "journey.json"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
}

func runnerReportPayload(t *testing.T, lease ShardLease, selected []ExecutionStep, includeState bool) []byte {
	t.Helper()
	receipt := map[string]any{"schema": RunnerReceiptSchema, "planId": lease.PlanID, "runId": lease.RunID, "sourceSHA": lease.SourceSHA,
		"shardId": lease.ShardID, "attemptId": lease.AttemptID, "mode": lease.Mode, "runner": lease.Runner,
		"claimIds": lease.ClaimIDs, "directStepIds": lease.DirectStepIDs}
	stateSet := map[string]bool{}
	for _, planned := range lease.Steps {
		for _, state := range planned.States {
			stateSet[state] = true
		}
	}
	var requiredStates []string
	for state := range stateSet {
		requiredStates = append(requiredStates, state)
	}
	sort.Strings(requiredStates)
	receipt["requiredStates"] = requiredStates
	steps := make([]map[string]any, 0, len(lease.SelectedStepNames))
	flows := make([]map[string]any, 0)
	for _, planned := range selected {
		row := map[string]any{"name": planned.Name, "status": "PASS",
			"plannedStepId": planned.ID, "plannedDirect": planned.Direct}
		if planned.Kind == "flow" {
			flows = append(flows, row)
		} else {
			steps = append(steps, row)
		}
	}
	if includeState {
		for _, state := range requiredStates {
			steps = append(steps, map[string]any{"name": "state probe: " + state,
				"status": "PASS", "details": map[string]any{"selectionRole": "lifecycle"}})
		}
	}
	payload, err := json.Marshal(map[string]any{"execution": receipt, "steps": steps, "flows": flows, "status": "PASS", "first_failure": nil})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
