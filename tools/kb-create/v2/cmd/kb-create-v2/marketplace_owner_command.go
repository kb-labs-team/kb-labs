package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

const maxMarketplaceOwnerRequestBytes = 64 * 1024

type marketplaceOwnerRequest struct {
	Mutation versionroot.ManagedMarketplaceMutation `json:"mutation"`
}

// executeMarketplaceOwnerMutation is the narrow server-side bridge from the
// authenticated Marketplace API to the Go installation owner. It accepts no
// root or environment values in the JSON payload; roots come from trusted
// Host configuration and are revalidated against the installation receipts.
func executeMarketplaceOwnerMutation(ctx context.Context, platformRoot string, input io.Reader) (any, *diag.Diag) {
	if platformRoot == "" {
		return nil, contracts.NewDiag("KB_INSTALL_RECEIPT_UNAVAILABLE", "The managed Marketplace owner is missing its installation binding.", "Restart the managed Host with its installation configuration.", nil)
	}
	if input == nil {
		return nil, contracts.NewDiag(contracts.CodeInputRequired, "The managed Marketplace request is missing.", "Send the typed mutation JSON on standard input.", nil)
	}
	data, err := io.ReadAll(io.LimitReader(input, maxMarketplaceOwnerRequestBytes+1))
	if err != nil {
		return nil, contracts.NewDiag(contracts.CodeInputRequired, "The managed Marketplace request could not be read.", "Retry the installation request.", err)
	}
	if len(data) == 0 || len(data) > maxMarketplaceOwnerRequestBytes {
		return nil, contracts.NewDiag(contracts.CodeInputRequired, "The managed Marketplace request has an invalid size.", "Send a request smaller than 64 KiB.", nil)
	}
	var request marketplaceOwnerRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return nil, contracts.NewDiag(contracts.CodeInputRequired, "The managed Marketplace request is invalid.", "Send only the typed mutation envelope.", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, contracts.NewDiag(contracts.CodeInputRequired, "The managed Marketplace request contains trailing data.", "Send exactly one JSON object.", err)
	}
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return nil, contracts.NewDiag("KB_INSTALL_RECEIPT_UNAVAILABLE", "The managed installation could not be identified.", "Run `kb-create doctor` before retrying the Marketplace operation.", err)
	}
	if err := layout.Validate(); err != nil {
		return nil, contracts.NewDiag("KB_INSTALL_RECEIPT_UNAVAILABLE", "The managed installation binding could not be validated.", "Run `kb-create doctor` before retrying the Marketplace operation.", err)
	}
	// The Host remains attached to the physical generation it started from;
	// protect that root even if another control plane has already advanced current.
	result, err := layout.RunManagedMarketplaceMutation(ctx, platformRoot, request.Mutation)
	if err != nil {
		return nil, contracts.NewDiag("KB_MARKETPLACE_INSTALL_FAILED", "The managed Marketplace installation did not activate.", "The prior active generation remains selected; inspect the Marketplace error and retry after correcting it.", err)
	}
	return result, nil
}
