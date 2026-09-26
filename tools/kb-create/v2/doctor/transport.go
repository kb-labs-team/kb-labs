package doctor

import (
	"encoding/json"
	"fmt"
)

// Input is a manifest-derived, value-free doctor request. Release tooling
// produces it from selected package manifests; the launcher handles only the
// declared requirement shape and presence state, never secret material.
type Input struct {
	Manifests  []Manifest      `json:"manifests"`
	Configured map[string]bool `json:"configured"`
}

// Response is the doctor report. Installation and Platform answer different
// questions (see sections.go) and are present when a platform root was given;
// Findings and Repair are the manifest-requirement gaps of the installation.
type Response struct {
	OK           bool       `json:"ok"`
	Installation *Section   `json:"installation,omitempty"`
	Platform     *Section   `json:"platform,omitempty"`
	Findings     []Finding  `json:"findings"`
	Repair       RepairPlan `json:"repair"`
}

func Decode(data []byte) (Input, error) {
	var input Input
	if err := json.Unmarshal(data, &input); err != nil {
		return Input{}, fmt.Errorf("decode V2 doctor input: %w", err)
	}
	if input.Configured == nil {
		input.Configured = map[string]bool{}
	}
	for _, manifest := range input.Manifests {
		if manifest.ID == "" {
			return Input{}, fmt.Errorf("doctor manifest ID is required")
		}
		for _, requirement := range manifest.Requirements {
			if requirement.Secret && requirement.ID == "" {
				return Input{}, fmt.Errorf("secret doctor requirement in %s needs an ID", manifest.ID)
			}
		}
	}
	return input, nil
}

func DiagnoseJSON(data []byte) (Response, error) {
	input, err := Decode(data)
	if err != nil {
		return Response{}, err
	}
	findings := Diagnose(input.Manifests, input.Configured)
	return Response{OK: len(findings) == 0, Findings: findings, Repair: PlanRepair(findings)}, nil
}
