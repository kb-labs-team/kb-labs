package marketplace

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// case: S-305.1
func TestGatewayInstallClientUsesPlatformMarketplaceOperation(t *testing.T) {
	const accessToken = "gateway-access-token-fixture"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != installEndpoint {
			t.Fatalf("Marketplace request = %s %s", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+accessToken {
			t.Fatalf("Marketplace Authorization = %q, want bearer token", got)
		}
		requestBody, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(requestBody), accessToken) {
			t.Fatal("Marketplace access token was serialized into the request body")
		}
		var body struct {
			Specs []string `json:"specs"`
			Scope string   `json:"scope"`
		}
		if err := json.Unmarshal(requestBody, &body); err != nil {
			t.Fatal(err)
		}
		if body.Scope != "platform" || len(body.Specs) != 1 || body.Specs[0] != "@kb-labs/commit" {
			t.Fatalf("Marketplace request body = %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"installed":[{"spec":"@kb-labs/commit","id":"@kb-labs/commit","version":"2.1.0","primaryKind":"plugin","source":"registry","signatureStatus":"verified"}],"scope":"platform"}`))
	}))
	defer server.Close()

	installed, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, accessToken)
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != 1 || installed[0].Spec != "@kb-labs/commit" || installed[0].ID != "@kb-labs/commit" || installed[0].Source != "registry" || installed[0].Version != "2.1.0" {
		t.Fatalf("Marketplace result = %#v", installed)
	}
}

func TestGatewayInstallClientRedactsBearerEchoedByGatewayFailure(t *testing.T) {
	const accessToken = "gateway-access-token-must-not-escape"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer "+accessToken {
			t.Fatalf("Marketplace Authorization = %q, want the transient bearer", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"code":"KB_AUTH_REQUIRED","message":"rejected ` + accessToken + `","cause":"authorization ` + accessToken + ` was rejected","details":{"plugin":"@kb-labs/commit ` + accessToken + `","source":"registry ` + accessToken + `"}}}`))
	}))
	defer server.Close()

	_, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, accessToken)
	failure, ok := err.(*InstallFailure)
	if !ok {
		t.Fatalf("Marketplace error = %#v, want typed install failure", err)
	}
	for _, value := range []string{failure.Error(), failure.Spec, failure.Source, failure.Code, failure.Message} {
		if strings.Contains(value, accessToken) {
			t.Fatalf("Gateway failure exposed transient bearer: %q", value)
		}
	}
	if failure.Cause == nil || strings.Contains(failure.Cause.Error(), accessToken) {
		t.Fatalf("Gateway failure cause = %v, bearer absent required", failure.Cause)
	}
	if failure.Spec != "@kb-labs/commit [redacted]" || failure.Source != "registry [redacted]" {
		t.Fatalf("redacted failure identity/source = %q/%q", failure.Spec, failure.Source)
	}
}

func TestGatewayInstallClientOmitsAuthorizationForLocalMarketplace(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "" {
			t.Fatalf("local Marketplace Authorization = %q, want no header", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"installed":[{"spec":"@kb-labs/commit","id":"@kb-labs/commit","version":"2.1.0","primaryKind":"plugin","source":"npm","signatureStatus":"unsigned"}]}`))
	}))
	defer server.Close()

	if _, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, ""); err != nil {
		t.Fatalf("local Marketplace install failed without auth: %v", err)
	}
}

// case: PC-001.2
func TestGatewayInstallClientWaitsForMarketplaceInstallPastFormerTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		time.Sleep(31 * time.Second)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"installed":[{"spec":"@kb-labs/commit","id":"@kb-labs/commit","version":"2.1.0","primaryKind":"plugin","source":"registry","signatureStatus":"verified"}],"scope":"platform"}`))
	}))
	defer server.Close()

	installed, err := (GatewayInstallClient{}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, "")
	if err != nil {
		t.Fatalf("slow Marketplace install failed: %v", err)
	}
	if len(installed) != 1 || installed[0].Spec != "@kb-labs/commit" || installed[0].ID != "@kb-labs/commit" {
		t.Fatalf("slow Marketplace install result = %#v", installed)
	}
}

func TestGatewayInstallClientPreservesAttemptedMarketplaceSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = writer.Write([]byte(`{"error":{"code":"KB_PLUGIN_NOT_FOUND","message":"Requested package spec was not published by the configured sources.","cause":"registry: not-found-unowned; npm: not-found-unowned","details":{"source":"configured Marketplace sources"}}}`))
	}))
	defer server.Close()

	_, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, "")
	failure, ok := err.(*InstallFailure)
	if !ok || failure.Spec != "@kb-labs/commit" || failure.Code != "KB_PLUGIN_NOT_FOUND" ||
		failure.Source != "configured Marketplace sources" || failure.Message != "Requested package spec was not published by the configured sources." ||
		failure.Cause == nil || failure.Cause.Error() != "registry: not-found-unowned; npm: not-found-unowned" {
		t.Fatalf("Marketplace failure = %#v", err)
	}
}

func TestGatewayInstallClientSelectsTheFailedSpecFromMarketplaceDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"KB_PLUGIN_NOT_FOUND","message":"Requested package spec was not published.","cause":"registry: not-found-unowned; npm: not-found-unowned","details":{"plugin":"@kb-labs/review"}}}`))
	}))
	defer server.Close()

	_, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL,
		[]string{"@kb-labs/commit", "@kb-labs/review"}, "")
	failure, ok := err.(*InstallFailure)
	if !ok || failure.Spec != "@kb-labs/review" {
		t.Fatalf("Marketplace failure spec = %#v, want the one identified by error details", err)
	}
}

func TestGatewayInstallClientRejectsResultThatDoesNotEchoRequestedSpec(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"installed":[{"id":"@kb-labs/commit","version":"2.1.0","primaryKind":"plugin","source":"npm","signatureStatus":"unsigned"}],"scope":"platform"}`))
	}))
	defer server.Close()

	_, err := (GatewayInstallClient{HTTP: server.Client()}).Install(context.Background(), server.URL, []string{"@kb-labs/commit"}, "")
	if err == nil || err.Error() != `Marketplace returned install spec "" at position 0, want "@kb-labs/commit"` {
		t.Fatalf("Marketplace missing-spec response error = %v", err)
	}
}
