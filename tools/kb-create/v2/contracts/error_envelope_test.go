package contracts

import (
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

func TestNewDiagUsesSharedCatalogWithoutSerializingRawCause(t *testing.T) {
	cause := errors.New("invalid config: token=top-secret-value")
	value := (&RequestValidationError{Field: "platformRoot", Cause: cause}).Diagnostic()
	if value.Code != CodeInputRequired || value.Unwrap() != cause {
		t.Fatalf("diag = %#v; cause was not kept internal", value)
	}
	envelope, err := diag.ToEnvelope(value)
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := diag.LookupCatalog(CodeInputRequired)
	if !ok {
		t.Fatal("input-required code is absent from the generated shared catalog")
	}
	if envelope.Message != entry.Message || envelope.Hint != entry.Hint || envelope.Area != entry.Area || envelope.Stage != entry.Stage || envelope.Severity != entry.Severity || envelope.Retryable != entry.Retryable {
		t.Fatalf("envelope = %+v; shared catalog entry = %+v", envelope, entry)
	}
	if envelope.Details["field"] != "platformRoot" {
		t.Fatalf("envelope omitted producer field: %+v", envelope.Details)
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["cause"] == nil || value.Reason == "" {
		t.Fatalf("sanitized cause must be visible in JSON and human diagnostics: %s / %#v", data, value)
	}
	if strings.Contains(string(data), "top-secret-value") || strings.Contains(value.Reason, "top-secret-value") {
		t.Fatalf("secret leaked through diagnostic cause: %s / %q", data, value.Reason)
	}
	if !strings.Contains(string(data), "[REDACTED]") || !strings.Contains(value.Reason, "[REDACTED]") {
		t.Fatalf("cause redaction marker missing: %s / %q", data, value.Reason)
	}
	for _, field := range []string{"area", "stage", "severity", "retryable", "message", "hint"} {
		if _, exists := fields[field]; !exists {
			t.Fatalf("canonical field %q missing: %s", field, data)
		}
	}
}

func TestNewDiagRejectsMissingCauseForCauseRequiredInstallCodes(t *testing.T) {
	for _, code := range []string{
		CodeProjectRegistrationFailed,
		CodeReleaseIndexInvalid,
		CodeReleaseIndexUnreadable,
		CodeReleaseIndexSealFailed,
	} {
		for _, missing := range []struct {
			name  string
			cause error
		}{{name: "nil"}, {name: "empty", cause: errors.New("")}} {
			t.Run(code+"/"+missing.name, func(t *testing.T) {
				defer func() {
					if recovered := recover(); recovered == nil {
						t.Fatalf("NewDiag(%q, %v) did not reject a missing required cause", code, missing.cause)
					}
				}()
				NewDiag(code, "failure", "retry", missing.cause)
			})
		}
	}
}

func TestNewUpdateIncompatibleRequiresCatalogDetailFields(t *testing.T) {
	for _, details := range []UpdateIncompatibleDetails{
		{Kind: "plugin", ID: "commit"},
		{Kind: "plugin", ID: "commit", SelectedVersion: "1.0.0"},
		{Kind: "plugin", ID: "commit", RequiredRange: "<2.0.0"},
	} {
		func() {
			defer func() {
				if recovered := recover(); recovered == nil {
					t.Fatalf("NewUpdateIncompatible accepted incomplete details: %+v", details)
				}
			}()
			NewUpdateIncompatible(details)
		}()
	}

	failure := NewUpdateIncompatible(UpdateIncompatibleDetails{
		ID: "commit", Kind: "plugin", RequiredRange: "<2.0.0", SelectedVersion: "2.0.0",
	})
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("complete update incompatibility does not satisfy catalog contract: %v", err)
	}
	if envelope.Message == "" || envelope.Hint == "" || envelope.Details["id"] != "commit" {
		t.Fatalf("update incompatibility did not render catalog text and details: %+v", envelope)
	}
}

func TestNewProjectRegistrationFailureBuildsCauseFromLocalContext(t *testing.T) {
	status := 502
	failure := NewProjectRegistrationFailure("login", "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", &status,
		"0123456789abcdef0123456789abcdef", "retry with the administrator credentials")
	if failure.Code != CodeProjectRegistrationFailed ||
		failure.Cause != "Project registration failed during login: KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE (HTTP 502); Gateway correlation ID 0123456789abcdef0123456789abcdef" ||
		failure.Meta["causeCode"] != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" ||
		failure.Meta["requestStage"] != "login" || failure.Meta["httpStatus"] != status ||
		failure.Meta["remoteCorrelationId"] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("registration failure = %#v", failure)
	}
}

func TestMarketplaceInstallDiagnosticPreservesCauseAndUsesInstallSpecRetry(t *testing.T) {
	failure := MarketplaceInstallDiagnostic("@kb-labs/commit", "npm", errors.New("KB_PLUGIN_NOT_FOUND: package spec unavailable"))
	if failure.Code != CodeMarketplaceInstallFailed || !strings.Contains(failure.Message, "@kb-labs/commit") || !strings.Contains(failure.Message, "npm") {
		t.Fatalf("Marketplace diagnostic = %#v", failure)
	}
	if failure.Cause != "KB_PLUGIN_NOT_FOUND: package spec unavailable" || failure.Reason != failure.Cause {
		t.Fatalf("Marketplace cause = %q, reason = %q", failure.Cause, failure.Reason)
	}
	if !strings.Contains(failure.Hint, "kb marketplace install @kb-labs/commit") || !strings.Contains(failure.Hint, "--scope platform") {
		t.Fatalf("Marketplace retry hint omitted the install spec or platform scope: %q", failure.Hint)
	}
}

func TestEmittedCodesAreKnown(t *testing.T) {
	root := ".."
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		base := filepath.Base(path)
		if filepath.Ext(path) != ".go" || len(base) >= len("_test.go") && base[len(base)-len("_test.go"):] == "_test.go" {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		check := func(code string) {
			if _, ok := diag.LookupCatalog(code); !ok {
				t.Errorf("%s emits code %s missing from the generated shared catalog", path, code)
			}
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.ValueSpec:
				for index, name := range value.Names {
					if len(name.Name) <= len("Code") || name.Name[:len("Code")] != "Code" || index >= len(value.Values) {
						continue
					}
					literal, ok := value.Values[index].(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						continue
					}
					code, err := strconv.Unquote(literal.Value)
					if err == nil {
						check(code)
					}
				}
			case *ast.CallExpr:
				if len(value.Args) == 0 {
					break
				}
				name := ""
				switch function := value.Fun.(type) {
				case *ast.Ident:
					name = function.Name
				case *ast.SelectorExpr:
					name = function.Sel.Name
				}
				if name != "NewDiag" && name != "New" && name != "Wrap" && name != "hostError" {
					break
				}
				literal, ok := value.Args[0].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					break
				}
				code, err := strconv.Unquote(literal.Value)
				if err == nil && len(code) > len("KB_") && code[:len("KB_")] == "KB_" {
					check(code)
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
