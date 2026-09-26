// Package transport is the machine boundary for V2. CI and agents submit the
// same InstallRequest JSON that a human wizard produces; no caller can encode
// a second shell-level installation semantic.
package transport

import (
	"encoding/json"
	"fmt"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/resolve"
)

type PlanResponse struct {
	OK    bool                           `json:"ok"`
	Plan  *contracts.ResolvedInstallPlan `json:"plan,omitempty"`
	Error *contracts.LauncherError       `json:"error,omitempty"`
}

func DecodeRequest(data []byte) (contracts.InstallRequest, error) {
	var request contracts.InstallRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return contracts.InstallRequest{}, fmt.Errorf("decode V2 request: %w", err)
	}
	return request.Normalize()
}

func Plan(data []byte, source catalog.Catalog) PlanResponse {
	return PlanWith(data, source, resolve.Options{})
}

// PlanWith is Plan for a launcher of a known version and target.
func PlanWith(data []byte, source catalog.Catalog, options resolve.Options) PlanResponse {
	request, err := DecodeRequest(data)
	if err != nil {
		return failure(contracts.CodeIncompatibleComponents, contracts.StageResolve, err)
	}
	resolved, err := resolve.PlanWith(request, source, options)
	if err != nil {
		if typed, ok := err.(*contracts.LauncherError); ok {
			return PlanResponse{OK: false, Error: typed}
		}
		return failure(contracts.CodeIncompatibleComponents, contracts.StageResolve, err)
	}
	return PlanResponse{OK: true, Plan: &resolved}
}

func failure(code string, stage contracts.ErrorStage, err error) PlanResponse {
	return PlanResponse{OK: false, Error: &contracts.LauncherError{Code: code, Stage: stage, Message: "V2 installation plan could not be resolved", Cause: err.Error(), Hint: "correct the request or choose a compatible release set"}}
}
