// Package journey owns deterministic installer-journey shard plans and their
// evidence finalization. QA remains the source of runnable claims and their
// resolved owner-specific prerequisites.
package journey

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	SelectionSchema   = "kb.qa-journey-selection/v1"
	PlanSchema        = "kb.devkit-journey-plan/v1"
	ShardResultSchema = "kb.devkit-journey-shard-result/v1"
	FinalResultSchema = "kb.devkit-journey-result/v1"
)

var sourceSHAPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Selection is the complete runnable selection resolved by the QA journey
// owner, not merely the subset of active release claims. Requires contains
// owner-resolved step IDs so sibling runner registrations cannot satisfy an
// edge accidentally.
type Selection struct {
	Schema           string         `json:"schema"`
	SourceSHA        string         `json:"sourceSHA"`
	MandatoryStepIDs []string       `json:"mandatoryStepIds"`
	Steps            []RunnableStep `json:"steps"`
}

type RunnableStep struct {
	ID        string   `json:"id"`
	Mode      string   `json:"mode"`
	Area      string   `json:"area"`
	Runner    string   `json:"runner"`
	Weight    int      `json:"weight,omitempty"`
	Mandatory bool     `json:"mandatory,omitempty"`
	Requires  []string `json:"requires,omitempty"`
}

type Plan struct {
	Schema           string         `json:"schema"`
	ID               string         `json:"id"`
	SourceSHA        string         `json:"sourceSHA"`
	ShardsPerMode    int            `json:"shardsPerMode"`
	MandatoryStepIDs []string       `json:"mandatoryStepIds"`
	FullSelection    []RunnableStep `json:"fullSelection"`
	Shards           []Shard        `json:"shards"`
}

type Shard struct {
	ID            string        `json:"id"`
	Mode          string        `json:"mode"`
	Domains       []string      `json:"domains"`
	DirectStepIDs []string      `json:"directStepIds"`
	Steps         []PlannedStep `json:"steps"`
	Runners       []string      `json:"runners"`
}

type PlannedStep struct {
	RunnableStep
	Direct bool `json:"direct"`
}

// BuildPlan partitions every step in the full runnable selection once per
// mode. Owner-specific dependency closures may repeat between shards.
func BuildPlan(selection Selection, shardsPerMode int) (Plan, error) {
	if selection.Schema != SelectionSchema {
		return Plan{}, fmt.Errorf("unsupported journey selection schema %q", selection.Schema)
	}
	if !sourceSHAPattern.MatchString(selection.SourceSHA) {
		return Plan{}, fmt.Errorf("sourceSHA must be the full 40-character lowercase commit SHA")
	}
	if shardsPerMode < 1 || shardsPerMode > 32 {
		return Plan{}, fmt.Errorf("shardsPerMode must be between 1 and 32")
	}
	if len(selection.Steps) == 0 {
		return Plan{}, fmt.Errorf("full runnable selection is empty")
	}

	steps := append([]RunnableStep(nil), selection.Steps...)
	byKey := make(map[string]RunnableStep, len(steps))
	modes := map[string]bool{}
	for i := range steps {
		step := &steps[i]
		if step.ID == "" || step.Area == "" || step.Runner == "" {
			return Plan{}, fmt.Errorf("runnable step at index %d must have id, area, and runner", i)
		}
		if step.Mode != "local" && step.Mode != "secured" {
			return Plan{}, fmt.Errorf("step %q has unsupported mode %q", step.ID, step.Mode)
		}
		if step.Weight < 0 {
			return Plan{}, fmt.Errorf("step %q has negative weight", step.ID)
		}
		key := stepKey(step.Mode, step.ID)
		if _, exists := byKey[key]; exists {
			return Plan{}, fmt.Errorf("duplicate runnable step %s", key)
		}
		step.Requires = uniqueSorted(step.Requires)
		byKey[key] = *step
		modes[step.Mode] = true
	}
	for _, step := range steps {
		for _, requiredID := range step.Requires {
			required, ok := byKey[stepKey(step.Mode, requiredID)]
			if !ok {
				return Plan{}, fmt.Errorf("step %s requires missing owner-resolved step %q", stepKey(step.Mode, step.ID), requiredID)
			}
			if required.Runner != step.Runner {
				return Plan{}, fmt.Errorf("step %s requires %q owned by %q, not its runner %q", stepKey(step.Mode, step.ID), requiredID, required.Runner, step.Runner)
			}
		}
	}
	if err := validateAcyclic(steps, byKey); err != nil {
		return Plan{}, err
	}

	mandatory := uniqueSorted(selection.MandatoryStepIDs)
	if len(mandatory) == 0 {
		return Plan{}, fmt.Errorf("mandatoryStepIds must name every active required step in the full route")
	}
	mandatorySet := make(map[string]bool, len(mandatory))
	for _, id := range mandatory {
		mode, stepID, ok := strings.Cut(id, ":")
		if !ok || (mode != "local" && mode != "secured") {
			return Plan{}, fmt.Errorf("mandatory step identity %q must use <mode>:<step-id>", id)
		}
		step, exists := byKey[stepKey(mode, stepID)]
		if !exists {
			return Plan{}, fmt.Errorf("mandatory step %q is absent from the full runnable selection", id)
		}
		if !step.Mandatory {
			return Plan{}, fmt.Errorf("mandatory step %q is not marked mandatory in the full runnable selection", id)
		}
		mandatorySet[stepKey(mode, stepID)] = true
	}
	for _, step := range steps {
		if step.Mandatory && !mandatorySet[stepKey(step.Mode, step.ID)] {
			return Plan{}, fmt.Errorf("active mandatory step %s is missing from mandatoryStepIds", stepKey(step.Mode, step.ID))
		}
	}
	selectionBytes, err := json.Marshal(struct {
		SourceSHA        string         `json:"sourceSHA"`
		MandatoryStepIDs []string       `json:"mandatoryStepIds"`
		Steps            []RunnableStep `json:"steps"`
		Count            int            `json:"shardsPerMode"`
	}{selection.SourceSHA, mandatory, canonicalSteps(steps), shardsPerMode})
	if err != nil {
		return Plan{}, fmt.Errorf("encode journey plan identity: %w", err)
	}
	sum := sha256.Sum256(selectionBytes)
	plan := Plan{Schema: PlanSchema, ID: "journey-" + hex.EncodeToString(sum[:]), SourceSHA: selection.SourceSHA,
		ShardsPerMode:    shardsPerMode,
		MandatoryStepIDs: mandatory,
		FullSelection:    canonicalSteps(steps)}

	orderedModes := make([]string, 0, len(modes))
	for mode := range modes {
		orderedModes = append(orderedModes, mode)
	}
	sort.Strings(orderedModes)
	for _, mode := range orderedModes {
		modeSteps := make([]RunnableStep, 0)
		for _, step := range steps {
			if step.Mode == mode {
				modeSteps = append(modeSteps, step)
			}
		}
		shardCount := shardsPerMode
		if len(modeSteps) < shardCount {
			shardCount = len(modeSteps)
		}
		buckets := make([][]RunnableStep, shardCount)
		weights := make([]int, shardCount)
		sort.Slice(modeSteps, func(i, j int) bool {
			wi, wj := effectiveWeight(modeSteps[i]), effectiveWeight(modeSteps[j])
			if wi != wj {
				return wi > wj
			}
			if modeSteps[i].Area != modeSteps[j].Area {
				return modeSteps[i].Area < modeSteps[j].Area
			}
			if modeSteps[i].Runner != modeSteps[j].Runner {
				return modeSteps[i].Runner < modeSteps[j].Runner
			}
			return modeSteps[i].ID < modeSteps[j].ID
		})
		for _, step := range modeSteps {
			bucket := lightestBucket(weights)
			buckets[bucket] = append(buckets[bucket], step)
			weights[bucket] += effectiveWeight(step)
		}
		for index, direct := range buckets {
			shard, err := buildShard(mode, index+1, direct, byKey)
			if err != nil {
				return Plan{}, err
			}
			plan.Shards = append(plan.Shards, shard)
		}
	}
	return plan, nil
}

func buildShard(mode string, index int, direct []RunnableStep, byKey map[string]RunnableStep) (Shard, error) {
	shard := Shard{ID: fmt.Sprintf("%s-%02d", mode, index), Mode: mode}
	directIDs := map[string]bool{}
	closure := map[string]RunnableStep{}
	var visit func(RunnableStep) error
	visit = func(step RunnableStep) error {
		key := stepKey(step.Mode, step.ID)
		if _, exists := closure[key]; exists {
			return nil
		}
		closure[key] = step
		for _, requiredID := range step.Requires {
			required, ok := byKey[stepKey(step.Mode, requiredID)]
			if !ok {
				return fmt.Errorf("step %s requires missing step %q", key, requiredID)
			}
			if required.Runner != step.Runner {
				return fmt.Errorf("step %s prerequisite %q has a different owner", key, requiredID)
			}
			if err := visit(required); err != nil {
				return err
			}
		}
		return nil
	}
	for _, step := range direct {
		directIDs[stepKey(step.Mode, step.ID)] = true
		shard.DirectStepIDs = append(shard.DirectStepIDs, step.ID)
		if err := visit(step); err != nil {
			return Shard{}, err
		}
	}
	sort.Strings(shard.DirectStepIDs)
	keys := make([]string, 0, len(closure))
	for key := range closure {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	domains, runners := map[string]bool{}, map[string]bool{}
	for _, key := range keys {
		step := closure[key]
		shard.Steps = append(shard.Steps, PlannedStep{RunnableStep: step, Direct: directIDs[key]})
		domains[step.Area], runners[step.Runner] = true, true
	}
	for domain := range domains {
		shard.Domains = append(shard.Domains, domain)
	}
	for runner := range runners {
		shard.Runners = append(shard.Runners, runner)
	}
	sort.Strings(shard.Domains)
	sort.Strings(shard.Runners)
	return shard, nil
}

func validateAcyclic(steps []RunnableStep, byKey map[string]RunnableStep) error {
	state := map[string]uint8{}
	var visit func(RunnableStep) error
	visit = func(step RunnableStep) error {
		key := stepKey(step.Mode, step.ID)
		if state[key] == 1 {
			return fmt.Errorf("journey selection has a prerequisite cycle at %s", key)
		}
		if state[key] == 2 {
			return nil
		}
		state[key] = 1
		for _, requiredID := range step.Requires {
			if err := visit(byKey[stepKey(step.Mode, requiredID)]); err != nil {
				return err
			}
		}
		state[key] = 2
		return nil
	}
	for _, step := range steps {
		if err := visit(step); err != nil {
			return err
		}
	}
	return nil
}

func canonicalSteps(steps []RunnableStep) []RunnableStep {
	result := append([]RunnableStep(nil), steps...)
	for i := range result {
		result[i].Requires = uniqueSorted(result[i].Requires)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Mode != result[j].Mode {
			return result[i].Mode < result[j].Mode
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func effectiveWeight(step RunnableStep) int {
	if step.Weight < 1 {
		return 1
	}
	return step.Weight
}

func lightestBucket(weights []int) int {
	best := 0
	for i := 1; i < len(weights); i++ {
		if weights[i] < weights[best] {
			best = i
		}
	}
	return best
}

func stepKey(mode, id string) string { return mode + ":" + id }

func uniqueSorted(values []string) []string {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			set[value] = true
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
