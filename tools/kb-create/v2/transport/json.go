// Package transport is the machine boundary for V2. CI and agents submit the
// same InstallRequest JSON that a human wizard produces; no caller can encode
// a second shell-level installation semantic.
package transport

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/resolve"
)

type PlanResponse struct {
	OK    bool                           `json:"ok"`
	Plan  *contracts.ResolvedInstallPlan `json:"plan,omitempty"`
	Error *diag.Diag                     `json:"error,omitempty"`
}

func DecodeRequest(data []byte) (contracts.InstallRequest, error) {
	// Accept request envelopes and CLI plan output. A saved plan is only a
	// convenient source of the original request; callers must resolve it again
	// against the supplied release catalog before applying anything.
	var envelope struct {
		Request json.RawMessage `json:"request"`
		OK      bool            `json:"ok"`
		Data    struct {
			Plan json.RawMessage `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil && len(envelope.Request) != 0 {
		data = envelope.Request
	} else if err == nil && envelope.OK && len(envelope.Data.Plan) != 0 {
		var plan struct {
			Request json.RawMessage `json:"request"`
		}
		if err := json.Unmarshal(envelope.Data.Plan, &plan); err != nil || len(plan.Request) == 0 {
			return contracts.InstallRequest{}, fmt.Errorf("decode saved plan request: missing plan.request")
		}
		data = plan.Request
	}
	var request contracts.InstallRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return contracts.InstallRequest{}, fmt.Errorf("decode V2 request: %w", err)
	}
	return request.Normalize()
}

func Plan(data []byte, source catalog.Catalog) PlanResponse {
	return PlanWith(data, source, resolve.Options{ProjectRootSelection: true})
}

// PlanWith is Plan for a launcher of a known version and target.
func PlanWith(data []byte, source catalog.Catalog, options resolve.Options) PlanResponse {
	request, err := DecodeRequest(data)
	if err != nil {
		var validation *contracts.RequestValidationError
		if errors.As(err, &validation) {
			return PlanResponse{OK: false, Error: validation.Diagnostic()}
		}
		return failure(contracts.CodeIncompatibleComponents, err)
	}
	if options.ProjectRootSelection && request.ProjectRoot != "" {
		projectRoot, validationErr := contracts.ValidateProjectSelection(request.ProjectRoot)
		if validationErr != nil {
			var validation *contracts.RequestValidationError
			if errors.As(validationErr, &validation) {
				return PlanResponse{OK: false, Error: validation.Diagnostic()}
			}
			return failure(contracts.CodeIncompatibleComponents, validationErr)
		}
		request.ProjectRoot = projectRoot
	}
	resolved, err := resolve.PlanWith(request, source, options)
	if err != nil {
		if typed, ok := err.(*diag.Diag); ok {
			return PlanResponse{OK: false, Error: typed}
		}
		return failure(contracts.CodeIncompatibleComponents, err)
	}
	return PlanResponse{OK: true, Plan: &resolved}
}

func failure(code string, err error) PlanResponse {
	return PlanResponse{OK: false, Error: contracts.NewDiag(code, "V2 installation plan could not be resolved", "correct the request or choose a compatible release set", err)}
}
