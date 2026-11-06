package v2cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
)

type recordingMarketplaceInstaller struct{}

func (recordingMarketplaceInstaller) Install(_ context.Context, _ string, specs []string) ([]contracts.MarketplaceInstallRecord, error) {
	installs := make([]contracts.MarketplaceInstallRecord, 0, len(specs))
	for _, spec := range specs {
		installs = append(installs, contracts.MarketplaceInstallRecord{
			ID: spec, Spec: spec, Version: "2.1.0", PrimaryKind: "plugin", Source: "registry", SignatureStatus: "verified",
		})
	}
	return installs, nil
}

type fixedMarketplaceInstaller struct {
	install contracts.MarketplaceInstallRecord
}

func (installer fixedMarketplaceInstaller) Install(_ context.Context, _ string, _ []string) ([]contracts.MarketplaceInstallRecord, error) {
	return []contracts.MarketplaceInstallRecord{installer.install}, nil
}

func TestScenarioMarketplaceReceiptJoinsRequestedSpecAndResolvedManifestIdentity(t *testing.T) {
	root := t.TempDir()
	installed := contracts.InstallReceipt{
		Schema: contracts.ReceiptSchema, ID: "scenario-receipt",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
			PlatformRoot: root, ScenarioID: "commit", MarketplaceInstallSpecs: []string{"@kb-labs/commit"},
		}},
		Verification: contracts.Verification{HostHealthURL: "http://127.0.0.1:4000/health"},
	}
	if err := receipt.Write(root, installed); err != nil {
		t.Fatal(err)
	}
	marketplaceResult := contracts.MarketplaceInstallRecord{
		Spec: "@kb-labs/commit", ID: "@kb-labs/commit", Version: "2.1.0", PrimaryKind: "plugin", Source: "npm", SignatureStatus: "unsigned",
	}
	if failure := installMarketplaceScenarioPlugins(context.Background(), root, &installed, fixedMarketplaceInstaller{install: marketplaceResult}); failure != nil {
		t.Fatalf("Marketplace scenario install failed: %#v", failure)
	}
	readBack, err := receipt.Read(root)
	if err != nil || len(readBack.MarketplaceInstalls) != 1 {
		t.Fatalf("Marketplace receipt = %#v, %v", readBack.MarketplaceInstalls, err)
	}
	result := readBack.MarketplaceInstalls[0]
	if result.Spec != "@kb-labs/commit" || result.ID != "@kb-labs/commit" || result.Source != "npm" {
		t.Fatalf("Marketplace receipt result = %#v", result)
	}
}

func TestScenarioMarketplaceFailureKeepsVerifiedInstallReceiptAndHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health" {
			writer.WriteHeader(http.StatusOK)
			return
		}
		if request.URL.Path != "/api/v1/marketplace/packages/install" || request.Method != http.MethodPost {
			t.Fatalf("Marketplace request = %s %s", request.Method, request.URL.Path)
		}
		var body struct {
			Specs []string `json:"specs"`
			Scope string   `json:"scope"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Scope != "platform" || len(body.Specs) != 1 || body.Specs[0] != "@kb-labs/commit" {
			t.Fatalf("Marketplace body = %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = writer.Write([]byte(`{"error":{"code":"KB_PLUGIN_NOT_FOUND","message":"Requested package spec was not published by the configured sources.","cause":"registry: not-found-unowned; npm: not-found-unowned","details":{"source":"configured Marketplace sources"}}}`))
	}))
	defer server.Close()

	root := t.TempDir()
	installed := contracts.InstallReceipt{
		Schema: contracts.ReceiptSchema, ID: "verified-receipt",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
			PlatformRoot: root, ScenarioID: "commit", MarketplaceInstallSpecs: []string{"@kb-labs/commit"},
		}},
		Verification: contracts.Verification{HostHealthURL: server.URL + "/health"},
	}
	if err := receipt.Write(root, installed); err != nil {
		t.Fatal(err)
	}

	failure := installMarketplaceScenarioPlugins(context.Background(), root, &installed,
		marketplace.GatewayInstallClient{HTTP: server.Client()})
	if failure == nil || failure.Code != contracts.CodeMarketplaceInstallFailed || failure.Meta["source"] != "configured Marketplace sources" {
		t.Fatalf("Marketplace failure = %#v", failure)
	}
	if failure.Cause != "KB_PLUGIN_NOT_FOUND: Requested package spec was not published by the configured sources.; registry: not-found-unowned; npm: not-found-unowned" ||
		!strings.Contains(failure.Hint, "@kb-labs/commit") || !strings.Contains(failure.Hint, "--scope platform") {
		t.Fatalf("Marketplace retry hint = %q", failure.Hint)
	}
	readBack, err := receipt.Read(root)
	if err != nil || readBack.ID != installed.ID || readBack.Plan.Request.ScenarioID != "commit" {
		t.Fatalf("installed receipt after Marketplace failure = %#v, %v", readBack, err)
	}
	health, err := server.Client().Get(server.URL + "/health")
	if err != nil || health.StatusCode != http.StatusOK {
		t.Fatalf("host health after Marketplace failure = %v, %v", health, err)
	}
	_ = health.Body.Close()
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("installed platform root disappeared: %v", err)
	}
}

func TestMarketplaceInstallFailureDiagnosticContainsCataloguedIdentitySourceAndRetry(t *testing.T) {
	diagnostic := contracts.MarketplaceInstallDiagnostic("@kb-labs/commit", "npm", fmt.Errorf("KB_PLUGIN_NOT_FOUND: package spec unavailable"))
	if diagnostic.Code != contracts.CodeMarketplaceInstallFailed || diagnostic.Meta["source"] != "npm" ||
		!strings.Contains(diagnostic.Message, "@kb-labs/commit") || !strings.Contains(diagnostic.Message, "npm") ||
		!strings.Contains(diagnostic.Hint, "@kb-labs/commit") || !strings.Contains(diagnostic.Hint, "--scope platform") {
		t.Fatalf("Marketplace install diagnostic = %#v", diagnostic)
	}
}
