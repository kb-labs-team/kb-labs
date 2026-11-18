package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
)

type recordingMarketplaceInstaller struct{}

func (recordingMarketplaceInstaller) Install(_ context.Context, _ string, specs []string, _ string) ([]contracts.MarketplaceInstallRecord, error) {
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

func (installer fixedMarketplaceInstaller) Install(_ context.Context, _ string, _ []string, _ string) ([]contracts.MarketplaceInstallRecord, error) {
	return []contracts.MarketplaceInstallRecord{installer.install}, nil
}

func TestMarketplaceAuthPreflightUsesDisclosureNotBootstrapCompletion(t *testing.T) {
	state := marketplaceAuthPreflightState{
		PreviousReceiptExists: true,
		SecuredAdmin:          true,
		BootstrapCompleted:    true,
		HasMarketplaceSpecs:   true,
	}
	if marketplaceAuthPreflightRequired(state) {
		t.Fatal("completed but undisclosed bootstrap must remain available for an authenticated Marketplace retry")
	}
	state.BootstrapDisclosed = true
	if !marketplaceAuthPreflightRequired(state) {
		t.Fatal("changed Marketplace request after credential disclosure must fail before Apply")
	}
	state.CanReconcile = true
	if marketplaceAuthPreflightRequired(state) {
		t.Fatal("exact owner reconciliation must not require user/bootstrap credentials")
	}
}

// case: S-305.1
func TestSecuredScenarioMarketplaceInstallUsesRealBootstrapAdminSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	origin := startSecuredProjectRegistrationGateway(t)
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	const password = "bootstrap-password-for-test"
	if err := store.Put(secrets.BootstrapPassword, password); err != nil {
		t.Fatal(err)
	}
	request := contracts.InstallRequest{
		PlatformRoot:            root,
		MarketplaceInstallSpecs: []string{"@kb-labs/commit"},
		Values: map[string]string{
			"gateway.access.mode":          `"secured"`,
			"gateway.bootstrap.adminEmail": `"admin@example.test"`,
			"gateway.bootstrap.tenantId":   `"workspace"`,
		},
	}
	client := marketplace.GatewayInstallClient{}

	_, anonymousErr := client.Install(context.Background(), origin, request.MarketplaceInstallSpecs, "")
	var anonymousFailure *marketplace.InstallFailure
	if !errors.As(anonymousErr, &anonymousFailure) || anonymousFailure.Code != "KB_AUTH_REQUIRED" {
		t.Fatalf("anonymous Marketplace install = %#v, want the secured Gateway's KB_AUTH_REQUIRED", anonymousErr)
	}

	accessToken, failure := scenarioMarketplaceAccessToken(context.Background(), store, origin, request)
	if failure != nil || accessToken == "" {
		t.Fatalf("bootstrap admin login token present=%v failure=%#v", accessToken != "", failure)
	}
	resultBytes, err := json.Marshal(applyCommandResult{registrationAccessToken: accessToken})
	if err != nil || bytes.Contains(resultBytes, []byte(accessToken)) || bytes.Contains(resultBytes, []byte(password)) {
		t.Fatalf("CLI result serialization exposed authentication material: %v", err)
	}
	installed := contracts.InstallReceipt{
		Schema:       contracts.ReceiptSchema,
		Plan:         contracts.ResolvedInstallPlan{Request: request},
		Verification: contracts.Verification{HostHealthURL: origin + "/health"},
	}
	if err := receipt.Write(root, installed); err != nil {
		t.Fatal(err)
	}
	if marketplaceFailure := installMarketplaceScenarioPlugins(context.Background(), root, &installed, accessToken, client); marketplaceFailure != nil {
		t.Fatalf("authenticated Marketplace install failed: %#v", marketplaceFailure)
	}
	if len(installed.MarketplaceInstalls) != 1 || installed.MarketplaceInstalls[0].Spec != "@kb-labs/commit" || installed.MarketplaceInstalls[0].ID != "@kb-labs/commit" || installed.MarketplaceInstalls[0].Source != "registry" {
		t.Fatalf("authenticated Marketplace receipt = %#v", installed.MarketplaceInstalls)
	}
	receiptBytes, err := os.ReadFile(receipt.Path(root))
	if err != nil || bytes.Contains(receiptBytes, []byte(accessToken)) || bytes.Contains(receiptBytes, []byte(password)) {
		t.Fatalf("receipt read/error or authentication material persisted: %v", err)
	}
	for _, sessionPath := range []string{filepath.Join(home, ".kb", "session.json"), filepath.Join(home, ".kb", "credentials.json")} {
		if _, err := os.Stat(sessionPath); err == nil {
			t.Fatalf("transient Marketplace session persisted at %s", sessionPath)
		}
	}
	if stored, present, err := store.Get(secrets.BootstrapPassword); err != nil || !present || stored != password {
		t.Fatalf("bootstrap credential changed: present=%v err=%v", present, err)
	}
	// A second install attempt may follow partial activation. The bootstrap credential
	// remains available until disclosure, so the retry must authenticate even though
	// it is no longer an initial install.
	retryToken, retryFailure := scenarioMarketplaceAccessToken(context.Background(), store, origin, request)
	if retryFailure != nil || retryToken == "" {
		t.Fatalf("undisclosed bootstrap retry token present=%v failure=%#v", retryToken != "", retryFailure)
	}
	if _, err := client.Install(context.Background(), origin, request.MarketplaceInstallSpecs, retryToken); err != nil {
		t.Fatalf("authenticated Marketplace retry after activation failed: %v", err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	if got, failure := scenarioMarketplaceAccessToken(context.Background(), store, origin, request); got != "" || failure == nil || failure.Code != "KB_AUTH_REQUIRED" {
		t.Fatalf("disclosed bootstrap token = %v/%#v, want an explicit authenticated recovery without credential reuse", got != "", failure)
	}
	invalidStore := secrets.Store{PlatformRoot: t.TempDir()}
	const invalidPassword = "wrong-password-for-test"
	if err := invalidStore.Put(secrets.BootstrapPassword, invalidPassword); err != nil {
		t.Fatal(err)
	}
	if token, loginFailure := scenarioMarketplaceAccessToken(context.Background(), invalidStore, origin, request); token != "" || loginFailure == nil || loginFailure.Code != "KB_AUTH_INVALID_CREDENTIALS" {
		t.Fatalf("invalid bootstrap credentials token=%v failure=%#v", token != "", loginFailure)
	} else if strings.Contains(loginFailure.Message, invalidPassword) || strings.Contains(loginFailure.Hint, invalidPassword) {
		t.Fatalf("login failure exposed bootstrap credential: %#v", loginFailure)
	}
}

func TestSecuredMarketplaceFailureDoesNotPersistOrExposeTransientBearer(t *testing.T) {
	const accessToken = "marketplace-transient-bearer-must-not-escape"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+accessToken {
			t.Fatalf("Marketplace Authorization did not contain the transient test token")
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(fmt.Sprintf(`{"error":{"code":"KB_AUTH_REQUIRED","message":"rejected %s","cause":"echoed %s","details":{"source":"registry","plugin":"@kb-labs/commit"}}}`, accessToken, accessToken)))
	}))
	defer server.Close()

	root := t.TempDir()
	installed := contracts.InstallReceipt{
		Schema: contracts.ReceiptSchema, ID: "secured-marketplace-failure",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
			PlatformRoot: root, ScenarioID: "commit", MarketplaceInstallSpecs: []string{"@kb-labs/commit"},
		}},
		Verification: contracts.Verification{HostHealthURL: server.URL + "/health"},
	}
	if err := receipt.Write(root, installed); err != nil {
		t.Fatal(err)
	}
	failure := installMarketplaceScenarioPlugins(context.Background(), root, &installed, accessToken,
		marketplace.GatewayInstallClient{HTTP: server.Client()})
	if failure == nil || failure.Code != contracts.CodeMarketplaceInstallFailed {
		t.Fatalf("secured Marketplace failure = %#v", failure)
	}
	serializedFailure, err := json.Marshal(failure)
	if err != nil || strings.Contains(string(serializedFailure), accessToken) {
		t.Fatalf("secured Marketplace diagnostic exposed bearer: %s / %v", serializedFailure, err)
	}
	result := applyDossier(root, "marketplace-auth-failure", "", installed.Plan, nil, failure)
	diagnosticPath, ok := result.Meta["diagnosticPath"].(string)
	if !ok {
		t.Fatalf("failure dossier was not written: %#v", result.Meta)
	}
	dossier, err := os.ReadFile(diagnosticPath)
	if err != nil || strings.Contains(string(dossier), accessToken) {
		t.Fatalf("failure dossier read/error or bearer leaked: %v", err)
	}
	receiptBytes, err := os.ReadFile(receipt.Path(root))
	if err != nil || strings.Contains(string(receiptBytes), accessToken) {
		t.Fatalf("receipt read/error or bearer leaked: %v", err)
	}
}

func TestDisclosedBootstrapIsNotReadForMarketplaceAuthorization(t *testing.T) {
	store := secrets.Store{PlatformRoot: t.TempDir()}
	if err := store.PutBootstrapPassword("must-not-be-reused", secrets.BootstrapOriginSupplied); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	request := contracts.InstallRequest{
		MarketplaceInstallSpecs: []string{"@kb-labs/commit"},
		Values:                  map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`},
	}
	token, failure := scenarioMarketplaceAccessToken(context.Background(), store, "http://127.0.0.1:4310", request)
	if token != "" || failure == nil || failure.Code != "KB_AUTH_REQUIRED" {
		t.Fatalf("disclosed bootstrap auth result token-present=%v failure=%#v", token != "", failure)
	}
	if strings.Contains(failure.Message+failure.Hint+failure.Reason, "must-not-be-reused") {
		t.Fatalf("diagnostic exposed bootstrap password: %#v", failure)
	}
	if stored, present, err := store.Get(secrets.BootstrapPassword); err != nil || present || stored != "" {
		t.Fatalf("disclosed bootstrap credential remained accessible: present=%v err=%v", present, err)
	}
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
	if failure := installMarketplaceScenarioPlugins(context.Background(), root, &installed, "", fixedMarketplaceInstaller{install: marketplaceResult}); failure != nil {
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

	failure := installMarketplaceScenarioPlugins(context.Background(), root, &installed, "",
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
