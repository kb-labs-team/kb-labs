package journey

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const shardResultFilename = "shard-result.json"
const (
	ShardLeaseSchema    = "kb.devkit-journey-shard-lease/v1"
	RunnerReceiptSchema = "kb.devkit-journey-runner-receipt/v1"
	PreparedRunSchema   = "kb.devkit-journey-prepared-run/v1"
)

type ExecutionStep struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	ClaimIDs     []string `json:"claimIds"`
	Capabilities []string `json:"capabilities"`
	States       []string `json:"states"`
	Direct       bool     `json:"direct"`
}

type ShardLease struct {
	Schema            string          `json:"schema"`
	PlanID            string          `json:"planId"`
	RunID             string          `json:"runId"`
	SourceSHA         string          `json:"sourceSHA"`
	ShardID           string          `json:"shardId"`
	AttemptID         string          `json:"attemptId"`
	Mode              string          `json:"mode"`
	Runner            string          `json:"runner"`
	ClaimIDs          []string        `json:"claimIds"`
	DirectStepIDs     []string        `json:"directStepIds"`
	DirectStepNames   []string        `json:"directStepNames"`
	SelectedStepNames []string        `json:"selectedStepNames"`
	Steps             []ExecutionStep `json:"steps"`
}

type PreparedRun struct {
	Schema    string       `json:"schema"`
	RunID     string       `json:"runId"`
	PlanID    string       `json:"planId"`
	SourceSHA string       `json:"sourceSHA"`
	Leases    []ShardLease `json:"leases"`
}

type ShardResult struct {
	Schema        string            `json:"schema"`
	PlanID        string            `json:"planId"`
	SourceSHA     string            `json:"sourceSHA"`
	ShardID       string            `json:"shardId"`
	Mode          string            `json:"mode"`
	Status        string            `json:"status"`
	Reports       []string          `json:"reports"`
	ReportDigests map[string]string `json:"reportDigests"`
	AttemptID     string            `json:"attemptId"`
	RunID         string            `json:"runId"`
	Runner        string            `json:"runner"`
	DirectStepIDs []string          `json:"directStepIds"`
}

type Result struct {
	Schema    string              `json:"schema"`
	PlanID    string              `json:"planId"`
	RunID     string              `json:"runId"`
	SourceSHA string              `json:"sourceSHA"`
	Status    string              `json:"status"`
	Shards    []ShardResult       `json:"shards"`
	Coverage  map[string][]string `json:"coverageReports"`
}

// WriteShardResult writes the manifest inside the shard's own evidence
// directory. It refuses to overlay a prior result from a reused directory.
func WriteShardResult(directory string, result ShardResult) error {
	if err := validateShardResultShape(result); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create evidence directory: %w", err)
	}
	path := filepath.Join(directory, shardResultFilename)
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("encode shard result: %w", err)
	}
	data = append(data, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("refusing to overwrite existing shard result %s", path)
		}
		return fmt.Errorf("write shard result: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write shard result: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close shard result: %w", err)
	}
	return nil
}

// BeginShard creates a unique lease before execution. The runner echoes this
// lease into its report, binding result evidence to this execution attempt.
func BeginShard(plan Plan, shardID string) (ShardLease, error) {
	if err := validatePlan(plan); err != nil {
		return ShardLease{}, err
	}
	var shard *Shard
	for index := range plan.Shards {
		if plan.Shards[index].ID == shardID {
			shard = &plan.Shards[index]
			break
		}
	}
	if shard == nil {
		return ShardLease{}, fmt.Errorf("shard %q is not part of plan %s", shardID, plan.ID)
	}
	if len(shard.Runners) != 1 {
		return ShardLease{}, fmt.Errorf("shard %q must have exactly one runner owner", shardID)
	}
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return ShardLease{}, fmt.Errorf("create shard attempt identity: %w", err)
	}
	return leaseForShard(plan, *shard, hex.EncodeToString(nonce)), nil
}

// PrepareRun creates the independent expected-attempt inventory before any shard executes.
func PrepareRun(plan Plan) (PreparedRun, error) {
	if err := validatePlan(plan); err != nil {
		return PreparedRun{}, err
	}
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return PreparedRun{}, fmt.Errorf("create prepared run identity: %w", err)
	}
	run := PreparedRun{Schema: PreparedRunSchema, RunID: hex.EncodeToString(nonce), PlanID: plan.ID, SourceSHA: plan.SourceSHA}
	for _, shard := range plan.Shards {
		lease, err := BeginShard(plan, shard.ID)
		if err != nil {
			return PreparedRun{}, err
		}
		lease.RunID = run.RunID
		run.Leases = append(run.Leases, lease)
	}
	return run, validatePreparedRun(plan, run)
}

func PreparedLease(plan Plan, prepared PreparedRun, shardID string) (ShardLease, error) {
	if err := validatePreparedRun(plan, prepared); err != nil {
		return ShardLease{}, err
	}
	for _, lease := range prepared.Leases {
		if lease.ShardID == shardID {
			return lease, nil
		}
	}
	return ShardLease{}, fmt.Errorf("shard %q is not in prepared run %s", shardID, prepared.RunID)
}

func validatePreparedRun(plan Plan, prepared PreparedRun) error {
	if prepared.Schema != PreparedRunSchema || prepared.RunID == "" || prepared.PlanID != plan.ID || prepared.SourceSHA != plan.SourceSHA || len(prepared.Leases) != len(plan.Shards) {
		return fmt.Errorf("prepared run identity or shard inventory does not match the immutable plan")
	}
	seen := map[string]bool{}
	for _, lease := range prepared.Leases {
		if lease.RunID != prepared.RunID || seen[lease.ShardID] {
			return fmt.Errorf("prepared run contains a duplicate or foreign lease")
		}
		if err := validateLeaseAgainstPlan(plan, lease); err != nil {
			return err
		}
		seen[lease.ShardID] = true
	}
	for _, shard := range plan.Shards {
		if !seen[shard.ID] {
			return fmt.Errorf("prepared run is missing lease for shard %q", shard.ID)
		}
	}
	return nil
}

// RecordShardResult verifies the runner-generated execution receipt and PASS
// rows before creating a digest-bound manifest. A caller cannot supply status.
func RecordShardResult(plan Plan, prepared PreparedRun, lease ShardLease, directory string, reports []string) error {
	if err := validatePreparedRun(plan, prepared); err != nil {
		return err
	}
	expectedLease, err := PreparedLease(plan, prepared, lease.ShardID)
	if err != nil {
		return err
	}
	expectedBytes, _ := json.Marshal(expectedLease)
	leaseBytes, _ := json.Marshal(lease)
	if !bytes.Equal(expectedBytes, leaseBytes) {
		return fmt.Errorf("execution lease does not match the independent prepared inventory")
	}
	if err := validateLeaseAgainstPlan(plan, lease); err != nil {
		return err
	}
	if len(reports) == 0 {
		return fmt.Errorf("at least one runner report is required")
	}
	if len(uniqueSorted(reports)) != len(reports) {
		return fmt.Errorf("runner report list contains an empty or duplicate path")
	}
	result := ShardResult{Schema: ShardResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA,
		ShardID: lease.ShardID, Mode: lease.Mode, Status: "passed", Reports: uniqueSorted(reports),
		ReportDigests: map[string]string{}, AttemptID: lease.AttemptID, RunID: prepared.RunID, Runner: lease.Runner,
		DirectStepIDs: lease.DirectStepIDs}
	reportPayloads := make([][]byte, 0, len(result.Reports))
	for _, relative := range result.Reports {
		path, err := safeReportPath(directory, relative)
		if err != nil {
			return fmt.Errorf("runner report: %w", err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read runner report: %w", err)
		}
		digest := sha256.Sum256(data)
		result.ReportDigests[relative] = hex.EncodeToString(digest[:])
		reportPayloads = append(reportPayloads, data)
	}
	if err := validateRunnerReports(lease, reportPayloads); err != nil {
		return err
	}
	return WriteShardResult(directory, result)
}

func leaseForShard(plan Plan, shard Shard, attemptID string) ShardLease {
	lease := ShardLease{Schema: ShardLeaseSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA,
		ShardID: shard.ID, AttemptID: attemptID, Mode: shard.Mode, Runner: shard.Runners[0]}
	direct := map[string]bool{}
	for _, id := range shard.DirectStepIDs {
		direct[id] = true
	}
	for _, planned := range shard.Steps {
		step := planned.RunnableStep
		lease.Steps = append(lease.Steps, ExecutionStep{ID: step.ID, Name: step.Name, Kind: step.Kind,
			ClaimIDs: step.ClaimIDs, Capabilities: step.Capabilities, States: step.States, Direct: direct[step.ID]})
		if direct[step.ID] {
			lease.DirectStepIDs = append(lease.DirectStepIDs, step.ID)
			lease.DirectStepNames = append(lease.DirectStepNames, step.Name)
			lease.ClaimIDs = append(lease.ClaimIDs, step.ClaimIDs...)
		}
		lease.SelectedStepNames = append(lease.SelectedStepNames, step.Name)
	}
	lease.DirectStepIDs = uniqueSorted(lease.DirectStepIDs)
	sort.Strings(lease.DirectStepNames)
	sort.Strings(lease.SelectedStepNames)
	lease.ClaimIDs = uniqueSorted(lease.ClaimIDs)
	sort.Slice(lease.Steps, func(i, j int) bool { return lease.Steps[i].ID < lease.Steps[j].ID })
	return lease
}

func validateLeaseAgainstPlan(plan Plan, lease ShardLease) error {
	if lease.Schema != ShardLeaseSchema || lease.PlanID != plan.ID || lease.SourceSHA != plan.SourceSHA || lease.AttemptID == "" {
		return fmt.Errorf("execution lease identity does not match the immutable plan")
	}
	for _, shard := range plan.Shards {
		if shard.ID != lease.ShardID {
			continue
		}
		expected := leaseForShard(plan, shard, lease.AttemptID)
		expected.RunID = lease.RunID
		a, _ := json.Marshal(expected)
		b, _ := json.Marshal(lease)
		if !bytes.Equal(a, b) {
			return fmt.Errorf("execution lease contents do not match planned shard %q", shard.ID)
		}
		return nil
	}
	return fmt.Errorf("execution lease refers to unplanned shard %q", lease.ShardID)
}

func validateRunnerReports(lease ShardLease, reports [][]byte) error {
	type reportStep struct {
		Name          string `json:"name"`
		Status        string `json:"status"`
		PlannedStepID string `json:"plannedStepId"`
		PlannedDirect *bool  `json:"plannedDirect"`
		Details       struct {
			SelectionRole string `json:"selectionRole"`
		} `json:"details"`
	}
	type reportFlow struct {
		Name          string `json:"name"`
		Status        string `json:"status"`
		PlannedStepID string `json:"plannedStepId"`
		PlannedDirect *bool  `json:"plannedDirect"`
	}
	type receipt struct {
		Schema         string   `json:"schema"`
		PlanID         string   `json:"planId"`
		RunID          string   `json:"runId"`
		SourceSHA      string   `json:"sourceSHA"`
		ShardID        string   `json:"shardId"`
		AttemptID      string   `json:"attemptId"`
		Mode           string   `json:"mode"`
		Runner         string   `json:"runner"`
		ClaimIDs       []string `json:"claimIds"`
		DirectStepIDs  []string `json:"directStepIds"`
		RequiredStates []string `json:"requiredStates"`
	}
	type reportDocument struct {
		Execution    receipt         `json:"execution"`
		Steps        []reportStep    `json:"steps"`
		Flows        []reportFlow    `json:"flows"`
		Status       string          `json:"status"`
		FirstFailure json.RawMessage `json:"first_failure"`
	}
	observedSteps := map[string][]reportStep{}
	observedFlows := map[string][]reportFlow{}
	observedNames := map[string][]reportStep{}
	stateSet := map[string]bool{}
	for _, step := range lease.Steps {
		for _, state := range step.States {
			stateSet[state] = true
		}
	}
	var requiredStates []string
	for state := range stateSet {
		requiredStates = append(requiredStates, state)
	}
	sort.Strings(requiredStates)
	for _, payload := range reports {
		var document reportDocument
		if err := json.Unmarshal(payload, &document); err != nil {
			return fmt.Errorf("parse runner report: %w", err)
		}
		r := document.Execution
		if r.Schema != RunnerReceiptSchema || r.PlanID != lease.PlanID || r.RunID != lease.RunID || r.SourceSHA != lease.SourceSHA || r.ShardID != lease.ShardID || r.AttemptID != lease.AttemptID || r.Mode != lease.Mode || r.Runner != lease.Runner || !equalStrings(uniqueSorted(r.ClaimIDs), lease.ClaimIDs) || !equalStrings(uniqueSorted(r.DirectStepIDs), lease.DirectStepIDs) || !equalStrings(uniqueSorted(r.RequiredStates), requiredStates) {
			return fmt.Errorf("runner report receipt does not match the execution lease")
		}
		if document.Status != "PASS" || (len(document.FirstFailure) > 0 && string(document.FirstFailure) != "null") {
			return fmt.Errorf("runner report did not finish successfully")
		}
		for _, step := range document.Steps {
			observedNames[step.Name] = append(observedNames[step.Name], step)
			if step.PlannedStepID != "" {
				observedSteps[step.PlannedStepID] = append(observedSteps[step.PlannedStepID], step)
			}
		}
		for _, flow := range document.Flows {
			if flow.PlannedStepID != "" {
				observedFlows[flow.PlannedStepID] = append(observedFlows[flow.PlannedStepID], flow)
			}
		}
	}
	for _, planned := range lease.Steps {
		if planned.Kind == "flow" {
			values := observedFlows[planned.ID]
			if len(values) != 1 || values[0].Name != planned.Name || values[0].Status != "PASS" || values[0].PlannedDirect == nil || *values[0].PlannedDirect != planned.Direct {
				return fmt.Errorf("combined runner reports are missing exactly one matching PASS flow event %q", planned.ID)
			}
		} else {
			values := observedSteps[planned.ID]
			if len(values) != 1 || values[0].Name != planned.Name || values[0].Status != "PASS" || values[0].PlannedDirect == nil || *values[0].PlannedDirect != planned.Direct {
				return fmt.Errorf("combined runner reports are missing exactly one matching PASS step %q", planned.ID)
			}
		}
	}
	for _, state := range requiredStates {
		name := "state probe: " + state
		rows := observedNames[name]
		if len(rows) != 1 || rows[0].Status != "PASS" || rows[0].Details.SelectionRole != "lifecycle" {
			return fmt.Errorf("combined runner reports do not prove required state %q with one passing lifecycle probe", state)
		}
	}
	return nil
}

// Finalize validates one manifest per planned shard and invokes the supplied
// runtime coverage evaluator with the reports actually found in the evidence
// directories. No expected passing case list is synthesized here.
func Finalize(plan Plan, prepared PreparedRun, evidenceDirectories []string, evaluateCoverage func(mode string, reports []string) error) (Result, error) {
	if err := validatePlan(plan); err != nil {
		return Result{}, err
	}
	if err := validatePreparedRun(plan, prepared); err != nil {
		return Result{}, err
	}
	if len(plan.Shards) == 0 {
		return Result{}, fmt.Errorf("journey plan has no shards")
	}
	if evaluateCoverage == nil {
		return Result{}, fmt.Errorf("runtime coverage evaluator is required")
	}
	expected := make(map[string]Shard, len(plan.Shards))
	for _, shard := range plan.Shards {
		if shard.ID == "" || shard.Mode == "" {
			return Result{}, fmt.Errorf("journey plan contains a shard without identity")
		}
		if _, duplicate := expected[shard.ID]; duplicate {
			return Result{}, fmt.Errorf("journey plan contains duplicate shard %q", shard.ID)
		}
		expected[shard.ID] = shard
	}
	if len(evidenceDirectories) != len(expected) {
		return Result{}, fmt.Errorf("received %d evidence directories for %d planned shards", len(evidenceDirectories), len(expected))
	}

	result := Result{Schema: FinalResultSchema, PlanID: plan.ID, RunID: prepared.RunID, SourceSHA: plan.SourceSHA, Status: "passed",
		Coverage: map[string][]string{}}
	seenDirs, seenShards, seenReports := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, directory := range evidenceDirectories {
		absolute, err := filepath.Abs(directory)
		if err != nil {
			return Result{}, fmt.Errorf("resolve evidence directory %q: %w", directory, err)
		}
		absolute = filepath.Clean(absolute)
		if seenDirs[absolute] {
			return Result{}, fmt.Errorf("duplicate evidence directory %s", absolute)
		}
		seenDirs[absolute] = true
		info, err := os.Stat(absolute)
		if err != nil || !info.IsDir() {
			return Result{}, fmt.Errorf("evidence path %s is not a readable directory", absolute)
		}
		manifestPath := filepath.Join(absolute, shardResultFilename)
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			return Result{}, fmt.Errorf("read shard manifest in %s: %w", absolute, err)
		}
		var shardResult ShardResult
		if err := json.Unmarshal(data, &shardResult); err != nil {
			return Result{}, fmt.Errorf("parse shard manifest in %s: %w", absolute, err)
		}
		if err := validateShardResultShape(shardResult); err != nil {
			return Result{}, fmt.Errorf("invalid shard manifest in %s: %w", absolute, err)
		}
		planned, ok := expected[shardResult.ShardID]
		if !ok {
			return Result{}, fmt.Errorf("foreign shard %q in evidence directory %s", shardResult.ShardID, absolute)
		}
		if seenShards[shardResult.ShardID] {
			return Result{}, fmt.Errorf("duplicate result for shard %q", shardResult.ShardID)
		}
		if shardResult.PlanID != plan.ID || shardResult.SourceSHA != plan.SourceSHA || shardResult.RunID != prepared.RunID {
			return Result{}, fmt.Errorf("stale or foreign plan identity for shard %q", shardResult.ShardID)
		}
		preparedLease, err := PreparedLease(plan, prepared, shardResult.ShardID)
		if err != nil || preparedLease.AttemptID != shardResult.AttemptID {
			return Result{}, fmt.Errorf("shard %q attempt does not match prepared inventory", shardResult.ShardID)
		}
		if shardResult.Mode != planned.Mode {
			return Result{}, fmt.Errorf("shard %q mode %q does not match planned mode %q", shardResult.ShardID, shardResult.Mode, planned.Mode)
		}
		if shardResult.Status != "passed" {
			return Result{}, fmt.Errorf("shard %q did not pass: status %q", shardResult.ShardID, shardResult.Status)
		}
		if len(planned.Runners) != 1 || shardResult.Runner != planned.Runners[0] || shardResult.AttemptID == "" || !equalStrings(uniqueSorted(shardResult.DirectStepIDs), planned.DirectStepIDs) {
			return Result{}, fmt.Errorf("shard %q execution identity does not match its planned runner and steps", shardResult.ShardID)
		}
		seenShards[shardResult.ShardID] = true
		lease := leaseForShard(plan, planned, shardResult.AttemptID)
		lease.RunID = prepared.RunID
		var reportPayloads [][]byte
		for _, relative := range shardResult.Reports {
			path, err := safeReportPath(absolute, relative)
			if err != nil {
				return Result{}, fmt.Errorf("shard %q report: %w", shardResult.ShardID, err)
			}
			if seenReports[path] {
				return Result{}, fmt.Errorf("report file is referenced by multiple shards: %s", path)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return Result{}, fmt.Errorf("read shard %q report: %w", shardResult.ShardID, err)
			}
			digest := sha256.Sum256(data)
			if shardResult.ReportDigests[relative] != hex.EncodeToString(digest[:]) {
				return Result{}, fmt.Errorf("shard %q report digest changed after recording", shardResult.ShardID)
			}
			reportPayloads = append(reportPayloads, data)
			seenReports[path] = true
			result.Coverage[shardResult.Mode] = append(result.Coverage[shardResult.Mode], path)
		}
		if err := validateRunnerReports(lease, reportPayloads); err != nil {
			return Result{}, fmt.Errorf("shard %q reports: %w", shardResult.ShardID, err)
		}
		result.Shards = append(result.Shards, shardResult)
	}
	for id := range expected {
		if !seenShards[id] {
			return Result{}, fmt.Errorf("missing result for planned shard %q", id)
		}
	}
	sort.Slice(result.Shards, func(i, j int) bool { return result.Shards[i].ShardID < result.Shards[j].ShardID })
	for mode := range result.Coverage {
		sort.Strings(result.Coverage[mode])
	}
	modes := make([]string, 0, len(result.Coverage))
	for mode := range result.Coverage {
		modes = append(modes, mode)
	}
	sort.Strings(modes)
	for _, mode := range modes {
		if err := evaluateCoverage(mode, result.Coverage[mode]); err != nil {
			return Result{}, fmt.Errorf("runtime release coverage failed for %s: %w", mode, err)
		}
	}
	return result, nil
}

func validatePlan(plan Plan) error {
	if plan.Schema != PlanSchema || plan.ID == "" || !sourceSHAPattern.MatchString(plan.SourceSHA) || plan.ShardsPerMode < 1 {
		return fmt.Errorf("invalid journey plan identity")
	}
	canonical, err := BuildPlan(Selection{Schema: SelectionSchema, SourceSHA: plan.SourceSHA,
		Producer: plan.Producer, Policy: plan.Policy, RequiredModes: plan.RequiredModes,
		Selectors: plan.Selectors, MandatoryStepIDs: plan.MandatoryStepIDs, Steps: plan.FullSelection}, plan.ShardsPerMode)
	canonicalBytes, canonicalErr := json.Marshal(canonical)
	planBytes, planErr := json.Marshal(plan)
	if err != nil || canonicalErr != nil || planErr != nil || !bytes.Equal(canonicalBytes, planBytes) {
		return fmt.Errorf("journey plan content does not match its immutable identity")
	}
	return nil
}

func validateShardResultShape(result ShardResult) error {
	if result.Schema != ShardResultSchema || result.PlanID == "" || !sourceSHAPattern.MatchString(result.SourceSHA) || result.ShardID == "" {
		return fmt.Errorf("manifest requires schema, planId, full sourceSHA, and shardId")
	}
	if result.Mode != "local" && result.Mode != "secured" {
		return fmt.Errorf("unsupported mode %q", result.Mode)
	}
	if result.Status == "" {
		return fmt.Errorf("status is required")
	}
	if len(result.Reports) == 0 {
		return fmt.Errorf("at least one runtime report is required")
	}
	if result.Status != "passed" || result.AttemptID == "" || result.RunID == "" || result.Runner == "" || len(result.DirectStepIDs) == 0 || len(result.ReportDigests) != len(result.Reports) {
		return fmt.Errorf("manifest requires passing runner identity, direct steps, attempt, and report digests")
	}
	for _, report := range result.Reports {
		if result.ReportDigests[report] == "" {
			return fmt.Errorf("manifest is missing digest for report %q", report)
		}
	}
	return nil
}

func safeReportPath(directory, relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return "", fmt.Errorf("report path must be relative to its shard evidence directory")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("report path escapes its shard evidence directory")
	}
	rootReal, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", fmt.Errorf("resolve evidence directory: %w", err)
	}
	path, err := filepath.EvalSymlinks(filepath.Join(directory, clean))
	if err != nil {
		return "", fmt.Errorf("resolve report %q: %w", relative, err)
	}
	relativeToRoot, err := filepath.Rel(rootReal, path)
	if err != nil || relativeToRoot == ".." || strings.HasPrefix(relativeToRoot, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("report path escapes its shard evidence directory")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("report %q is not a regular file", relative)
	}
	return path, nil
}
