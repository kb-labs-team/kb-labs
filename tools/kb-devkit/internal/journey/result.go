package journey

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const shardResultFilename = "shard-result.json"

type ShardResult struct {
	Schema    string   `json:"schema"`
	PlanID    string   `json:"planId"`
	SourceSHA string   `json:"sourceSHA"`
	ShardID   string   `json:"shardId"`
	Mode      string   `json:"mode"`
	Status    string   `json:"status"`
	Reports   []string `json:"reports"`
}

type Result struct {
	Schema    string              `json:"schema"`
	PlanID    string              `json:"planId"`
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

// RecordShardResult creates evidence for a shard only when that shard belongs
// to the supplied immutable plan. The manifest identity is copied from plan.
func RecordShardResult(plan Plan, shardID, status, directory string, reports []string) error {
	if err := validatePlan(plan); err != nil {
		return err
	}
	for _, shard := range plan.Shards {
		if shard.ID == shardID {
			return WriteShardResult(directory, ShardResult{Schema: ShardResultSchema, PlanID: plan.ID,
				SourceSHA: plan.SourceSHA, ShardID: shard.ID, Mode: shard.Mode, Status: status, Reports: reports})
		}
	}
	return fmt.Errorf("shard %q is not part of plan %s", shardID, plan.ID)
}

// Finalize validates one manifest per planned shard and invokes the supplied
// runtime coverage evaluator with the reports actually found in the evidence
// directories. No expected passing case list is synthesized here.
func Finalize(plan Plan, evidenceDirectories []string, evaluateCoverage func(mode string, reports []string) error) (Result, error) {
	if err := validatePlan(plan); err != nil {
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

	result := Result{Schema: FinalResultSchema, PlanID: plan.ID, SourceSHA: plan.SourceSHA, Status: "passed",
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
		if shardResult.PlanID != plan.ID || shardResult.SourceSHA != plan.SourceSHA {
			return Result{}, fmt.Errorf("stale or foreign plan identity for shard %q", shardResult.ShardID)
		}
		if shardResult.Mode != planned.Mode {
			return Result{}, fmt.Errorf("shard %q mode %q does not match planned mode %q", shardResult.ShardID, shardResult.Mode, planned.Mode)
		}
		if shardResult.Status != "passed" {
			return Result{}, fmt.Errorf("shard %q did not pass: status %q", shardResult.ShardID, shardResult.Status)
		}
		seenShards[shardResult.ShardID] = true
		for _, relative := range shardResult.Reports {
			path, err := safeReportPath(absolute, relative)
			if err != nil {
				return Result{}, fmt.Errorf("shard %q report: %w", shardResult.ShardID, err)
			}
			if seenReports[path] {
				return Result{}, fmt.Errorf("report file is referenced by multiple shards: %s", path)
			}
			seenReports[path] = true
			result.Coverage[shardResult.Mode] = append(result.Coverage[shardResult.Mode], path)
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
		MandatoryStepIDs: plan.MandatoryStepIDs, Steps: plan.FullSelection}, plan.ShardsPerMode)
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
