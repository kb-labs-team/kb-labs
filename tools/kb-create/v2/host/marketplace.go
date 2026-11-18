package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
)

// ReconcileMarketplace asks the running host to verify prior Marketplace
// receipt records against its Marketplace-owned platform inventory. The local
// host-control bearer is machine-owned and never persisted in the receipt.
func (r *ProcessRunner) ReconcileMarketplace(ctx context.Context, request contracts.MarketplaceInstallReconciliationRequest) (contracts.MarketplaceInstallReconciliationResponse, error) {
	if request.InstallationID == "" || request.InstallationID != r.InstallationID {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The installed host does not match this platform's installation identity.", r.InstallRoot, request.Expected...)
	}
	if request.Scope != "platform" || len(request.Expected) == 0 {
		return contracts.MarketplaceInstallReconciliationResponse{}, contracts.NewDiag(contracts.CodeInputRequired,
			"Marketplace reconciliation requires the recorded platform package installs.",
			"Retry `kb-create install` with the request recorded in the active receipt.", nil)
	}
	if r.ControlAddress == "" || r.ControlCredential == "" || !validControlAddress(r.ControlAddress) {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host's local Marketplace control channel is unavailable.", r.InstallRoot, request.Expected...)
	}
	body, err := json.Marshal(request)
	if err != nil {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The recorded Marketplace install identity could not be encoded.", r.InstallRoot, request.Expected...)
	}
	requestHTTP, err := http.NewRequestWithContext(ctx, http.MethodPost, r.ControlAddress+"/v1/marketplace/reconcile", bytes.NewReader(body))
	if err != nil {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host's local Marketplace control channel could not be reached.", r.InstallRoot, request.Expected...)
	}
	requestHTTP.Header.Set("Content-Type", "application/json")
	requestHTTP.Header.Set("Authorization", "Bearer "+r.ControlCredential)
	response, err := r.client().Do(requestHTTP)
	if err != nil {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host's local Marketplace control channel could not be reached.", r.InstallRoot, request.Expected...)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host's local Marketplace control response could not be read.", r.InstallRoot, request.Expected...)
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error *diag.Diag `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Error != nil {
			return contracts.MarketplaceInstallReconciliationResponse{}, failure.Error
		}
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host could not reconcile the Marketplace package state.", r.InstallRoot, request.Expected...)
	}
	var result contracts.MarketplaceInstallReconciliationResponse
	if err := json.Unmarshal(data, &result); err != nil || !result.OK || result.InstallationID != request.InstallationID || !marketplaceReconciliationMatches(request.Expected, result.Matched) {
		return contracts.MarketplaceInstallReconciliationResponse{}, marketplaceStateUnavailable("The supervised host returned incomplete Marketplace reconciliation evidence.", r.InstallRoot, request.Expected...)
	}
	return result, nil
}

func marketplaceReconciliationMatches(expected []contracts.MarketplaceInstallRecord, matched []contracts.MarketplaceReconciledRecord) bool {
	if len(expected) == 0 || len(expected) != len(matched) {
		return false
	}
	for index, wanted := range expected {
		actual := matched[index]
		if !actual.Enabled || actual.Spec != wanted.Spec || actual.ID != wanted.ID || actual.Version != wanted.Version ||
			actual.PrimaryKind != wanted.PrimaryKind || actual.Source != wanted.Source ||
			actual.SignatureStatus != wanted.SignatureStatus ||
			(wanted.Integrity != "" && actual.Integrity != wanted.Integrity) || actual.Integrity == "" {
			return false
		}
	}
	return true
}

func marketplaceStateUnavailable(reason, platformRoot string, records ...contracts.MarketplaceInstallRecord) *diag.Diag {
	packageID := "unknown"
	if len(records) > 0 && records[0].ID != "" {
		packageID = records[0].ID
	}
	return contracts.MarketplaceStateUnavailable(packageID, platformRoot, errors.New(reason))
}
