package host

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
)

func TestProcessRunnerReconcilesThroughAuthenticatedHostControl(t *testing.T) {
	const token = "machine-host-control-token-fixture"
	expected := []contracts.MarketplaceInstallRecord{{
		Spec: "@kb-labs/commit", ID: "@kb-labs/commit", Version: "2.120.1",
		PrimaryKind: "plugin", Source: "registry", SignatureStatus: "verified", Integrity: "sha512-lock-entry",
	}}
	matched := []contracts.MarketplaceReconciledRecord{{MarketplaceInstallRecord: expected[0], Enabled: true}}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/marketplace/reconcile" {
			t.Fatalf("host-control request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer "+token {
			t.Fatal("host-control request omitted its machine-owned bearer")
		}
		var body contracts.MarketplaceInstallReconciliationRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.InstallationID != "installation-1" || body.Scope != "platform" || len(body.Expected) != 1 || body.Expected[0] != expected[0] {
			t.Fatalf("host-control reconciliation body = %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(contracts.MarketplaceInstallReconciliationResponse{
			OK: true, InstallationID: "installation-1", Matched: matched,
		})
	}))
	defer server.Close()
	runner := &ProcessRunner{InstallRoot: t.TempDir(), InstallationID: "installation-1", ControlAddress: server.URL, ControlCredential: token, HTTP: server.Client()}
	request := contracts.MarketplaceInstallReconciliationRequest{InstallationID: "installation-1", Scope: "platform", Expected: expected}
	response, err := runner.ReconcileMarketplace(context.Background(), request)
	if err != nil || !response.OK || len(response.Matched) != 1 || response.Matched[0] != matched[0] {
		t.Fatalf("reconcile response/error = %#v / %v", response, err)
	}
}

func TestProcessRunnerMarketplaceReconciliationFailsClosed(t *testing.T) {
	request := contracts.MarketplaceInstallReconciliationRequest{
		InstallationID: "installation-1", Scope: "platform",
		Expected: []contracts.MarketplaceInstallRecord{{Spec: "@kb-labs/commit", ID: "@kb-labs/commit", Version: "2.0.0", PrimaryKind: "plugin", Source: "registry", SignatureStatus: "verified"}},
	}
	runner := &ProcessRunner{InstallRoot: t.TempDir(), InstallationID: "installation-1"}
	_, err := runner.ReconcileMarketplace(context.Background(), request)
	var unavailable *diag.Diag
	if !errors.As(err, &unavailable) || unavailable.Code != "KB_MARKETPLACE_STATE_UNAVAILABLE" {
		t.Fatalf("missing local host control = %v, want typed unavailable", err)
	}
	request.InstallationID = "another-installation"
	_, err = runner.ReconcileMarketplace(context.Background(), request)
	if !errors.As(err, &unavailable) || unavailable.Code != "KB_MARKETPLACE_STATE_UNAVAILABLE" {
		t.Fatalf("foreign installation id = %v, want typed unavailable", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"ok":false,"error":{"code":"KB_MARKETPLACE_STATE_DRIFT","area":"plugin","stage":"verify","severity":"error","retryable":false,"message":"The requested Marketplace install is missing or no longer matches the installed package state.","hint":"Run kb auth login, then kb marketplace install.","details":{"package":"@kb-labs/commit","scope":"platform","loginCommand":"kb auth login","installCommand":"kb marketplace install @kb-labs/commit --scope platform"}}}`))
	}))
	defer server.Close()
	request.InstallationID = "installation-1"
	runner.ControlAddress = server.URL
	runner.ControlCredential = "machine-host-control-token-fixture"
	_, err = runner.ReconcileMarketplace(context.Background(), request)
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_MARKETPLACE_STATE_DRIFT" {
		t.Fatalf("Marketplace drift response = %#v", err)
	}
}
