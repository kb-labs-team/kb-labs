package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
)

type loginTokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
	TenantID     string `json:"tenantId"`
}

type projectRegistrationResponse struct {
	ID             string `json:"id"`
	Path           string `json:"path"`
	AlreadyExisted *bool  `json:"alreadyExisted"`
}

func registerProject(platformRoot, projectRoot string) (projectRegistrationResult, error) {
	active, err := receipt.Read(projectReceiptRoot(platformRoot))
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_INSTALL_RECEIPT_UNAVAILABLE", "The installed receipt could not be read.", "", 0)
	}
	origin, err := gateway.OriginFromHealthURL(active.Verification.HostHealthURL)
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_HOST_SPEC_INVALID", "The Gateway address in the receipt is invalid.", "", 0)
	}
	accessToken := ""
	if adminEmail, secured := configuredFirstAdmin(active.Plan.Request); secured {
		store := secrets.Store{PlatformRoot: platformRoot}
		disclosed, readErr := store.BootstrapDisclosed()
		if readErr != nil {
			return projectRegistrationResult{}, registrationBoundaryFailure("KB_INSTALL_SECRET_INPUT_INVALID", "The first administrator bootstrap state is unavailable.", "login", 0)
		}
		if disclosed {
			return projectRegistrationResult{}, registrationBoundaryFailure(contracts.CodeProjectRegistrationFailed, "Bootstrap is complete; register the project under your own login.", "login", 0)
		}
		password, present, readErr := store.Get(secrets.BootstrapPassword)
		if readErr != nil || !present {
			return projectRegistrationResult{}, registrationBoundaryFailure("KB_INSTALL_SECRET_INPUT_INVALID", "The first administrator password is unavailable.", "login", 0)
		}
		tenantID := unquoteRequestValue(active.Plan.Request.Values["gateway.bootstrap.tenantId"])
		tokens, loginErr := loginForFirstAdmin(context.Background(), origin, adminEmail, password, tenantID)
		if loginErr != nil {
			return projectRegistrationResult{}, loginErr
		}
		accessToken = tokens.AccessToken
	}
	return addProjectThroughGateway(origin, projectRoot, accessToken)
}

func registerProjectWithAccessToken(platformRoot, projectRoot, accessToken string) (projectRegistrationResult, error) {
	active, err := receipt.Read(projectReceiptRoot(platformRoot))
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_INSTALL_RECEIPT_UNAVAILABLE", "The installed receipt could not be read.", "register", 0)
	}
	origin, err := gateway.OriginFromHealthURL(active.Verification.HostHealthURL)
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_HOST_SPEC_INVALID", "The Gateway address in the receipt is invalid.", "register", 0)
	}
	return addProjectThroughGateway(origin, projectRoot, accessToken)
}

func existingProjectSelection(platformRoot, selected string) (bool, *diag.Diag) {
	receiptRoot := projectReceiptRoot(platformRoot)
	if _, err := os.Stat(receipt.Path(receiptRoot)); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, contracts.NewDiag(contracts.CodeReceiptUnavailable, "The active install receipt could not be checked.", "Check the platform root permissions, then run `kb-create doctor`.", err)
	}
	active, err := receipt.Read(receiptRoot)
	if err != nil {
		var schemaFailure receipt.UnsupportedSchemaError
		if errors.As(err, &schemaFailure) {
			return false, contracts.NewDiag(contracts.CodeReceiptUnavailable,
				"The active receipt schema does not contain the project identity required by this installer.",
				"Inspect the installation with `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", platformRoot)+"`, then reinstall it with the current kb-create launcher.", err)
		}
		return false, contracts.NewDiag(contracts.CodeReceiptUnavailable, "The active install receipt could not be read.", "Run `kb-create doctor --platform-root PATH` to inspect the installation.", err)
	}
	if selected == "" {
		return true, nil
	}
	selectedPath, err := contracts.AbsolutePath(selected)
	if err != nil {
		return true, contracts.NewDiag(contracts.CodeInputRequired, "The selected project path could not be resolved.", "Pass an existing project directory with `--project-root PATH`.", err)
	}
	if active.ProjectSelectedPath == "" || !validProjectID(active.ProjectID) || !filepath.IsAbs(active.ProjectCanonicalPath) {
		if active.Plan.Request.ProjectRoot == "" {
			return false, nil
		}
		if selectedPath == active.Plan.Request.ProjectRoot {
			return false, nil
		}
		return true, missingProjectIdentityFailure(active, platformRoot)
	}
	if selectedPath != active.ProjectSelectedPath && selectedPath != active.ProjectCanonicalPath {
		failure := contracts.NewDiag(contracts.CodeProjectSelectionChanged,
			"The selected project path spelling differs from the project selection recorded by this installation.",
			projectRegistrationHint(active, selected), nil)
		return true, failure
	}
	return true, nil
}

func projectReceiptRoot(platformRoot string) string {
	current := contracts.CurrentPlatformRoot(platformRoot)
	if _, err := os.Stat(receipt.Path(current)); err == nil {
		return current
	}
	return platformRoot
}

func missingProjectIdentityFailure(active contracts.InstallReceipt, platformRoot string) *diag.Diag {
	return contracts.NewDiag(contracts.CodeReceiptUnavailable,
		"The active receipt does not contain the project selection and registry identity required by this installer.",
		"Inspect the installation with `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", platformRoot)+"`, then reinstall it with the current kb-create launcher.",
		fmt.Errorf("receipt schema %q is missing project identity fields", active.Schema))
}

func projectRegistrationHint(active contracts.InstallReceipt, projectRoot string) string {
	commands := make([]string, 0, 3)
	if email, secured := configuredFirstAdmin(active.Plan.Request); secured {
		origin, _ := gateway.OriginFromHealthURL(active.Verification.HostHealthURL)
		commands = append(commands, contracts.ShellCommand("kb", "auth", "login", "--gateway-url", origin, "--email", email))
	}
	commands = append(commands, contracts.ShellCommand("kb", "project", "add", projectRoot), contracts.ShellCommand("kb", "project", "show", projectRoot))
	if len(commands) == 3 {
		return "Run `" + commands[0] + "`, then `" + commands[1] + "`, then `" + commands[2] + "`."
	}
	return "Run `" + commands[0] + "`, then `" + commands[1] + "`."
}

func completedBootstrapProjectNotice(active contracts.InstallReceipt, projectRoot string, allowBootstrapRegistration bool) (string, error) {
	if projectRoot == "" || active.ProjectID != "" || allowBootstrapRegistration {
		return "", nil
	}
	completed, err := (secrets.Store{PlatformRoot: active.Plan.Request.PlatformRoot}).BootstrapCompleted()
	if err != nil {
		return "", err
	}
	if !completed {
		return "", nil
	}
	return "Project registration is still needed. Sign in as the project owner, then " + projectRegistrationHint(active, projectRoot), nil
}

func unquoteRequestValue(value string) string {
	var text string
	if json.Unmarshal([]byte(value), &text) == nil {
		return text
	}
	return ""
}

func loginForFirstAdmin(ctx context.Context, origin, email, password, tenantID string) (loginTokens, error) {
	credentials := map[string]string{"email": email, "password": password}
	if tenantID != "" {
		credentials["tenantId"] = tenantID
	}
	body, err := json.Marshal(credentials)
	if err != nil {
		return loginTokens{}, registrationBoundaryFailure("KB_RUNTIME_UNEXPECTED", "The Gateway login request could not be encoded.", "login", 0)
	}
	responseBody, status, err := postRegistrationRequest(ctx, origin+"/auth/login/cli", body, "")
	if err != nil {
		return loginTokens{}, registrationBoundaryFailure("KB_AUTH_GATEWAY_UNREACHABLE", "The Gateway login request could not be completed.", "login", status)
	}
	if status < 200 || status >= 300 {
		var raw json.RawMessage
		failure, decodeErr := result.DecodeResultWithContext(responseBody, &raw, result.RemoteFailureContext{RequestStage: "login", HTTPStatus: status})
		if decodeErr != nil || failure == nil {
			return loginTokens{}, registrationProtocolFailure("login", status)
		}
		return loginTokens{}, failure
	}
	var tokens loginTokens
	if failure, decodeErr := result.DecodeResultWithContext(responseBody, &tokens, result.RemoteFailureContext{RequestStage: "login", HTTPStatus: status}); decodeErr != nil {
		return loginTokens{}, registrationProtocolFailure("login", status)
	} else if failure != nil {
		return loginTokens{}, failure
	}
	if tokens.AccessToken == "" || tokens.RefreshToken == "" || tokens.ExpiresIn <= 0 {
		return loginTokens{}, registrationProtocolFailure("login", status)
	}
	return tokens, nil
}

func addProjectThroughGateway(origin, projectRoot, accessToken string) (projectRegistrationResult, error) {
	body, err := json.Marshal(map[string]string{"path": projectRoot})
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_RUNTIME_UNEXPECTED", "The project registration request could not be encoded.", "register", 0)
	}
	responseBody, status, err := postRegistrationRequest(context.Background(), origin+"/api/v1/projects", body, accessToken)
	if err != nil {
		return projectRegistrationResult{}, registrationBoundaryFailure("KB_HOST_UNREACHABLE", "The Gateway project registration request could not be completed.", "register", status)
	}
	var payload projectRegistrationResponse
	failure, decodeErr := result.DecodeResultWithContext(responseBody, &payload, result.RemoteFailureContext{RequestStage: "register", HTTPStatus: status})
	if failure != nil {
		return projectRegistrationResult{}, failure
	}
	if decodeErr != nil || status < 200 || status >= 300 || !validProjectID(payload.ID) || !filepath.IsAbs(payload.Path) || payload.AlreadyExisted == nil {
		return projectRegistrationResult{}, registrationProtocolFailure("register", status)
	}
	return projectRegistrationResult{ID: payload.ID, CanonicalPath: payload.Path, AlreadyExisted: *payload.AlreadyExisted}, nil
}

func validProjectID(value string) bool {
	if len(value) != len("prj_")+16 || value[:len("prj_")] != "prj_" {
		return false
	}
	for _, character := range value[len("prj_"):] {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func postRegistrationRequest(ctx context.Context, target string, body []byte, accessToken string) ([]byte, int, error) {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, 0, fmt.Errorf("the applied Gateway URL is invalid")
	}
	requestContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, 0, fmt.Errorf("the Gateway request could not be created")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-Id", diag.NewCorrelationID())
	if accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, response.StatusCode, fmt.Errorf("the Gateway response could not be read")
	}
	return responseBody, response.StatusCode, nil
}

func registrationBoundaryFailure(code, message, stage string, status int) *diag.Diag {
	failure := diag.New(code, message)
	if stage != "" || status != 0 {
		failure.Meta = map[string]any{}
		if stage != "" {
			failure.Meta["requestStage"] = stage
		}
		if status != 0 {
			failure.Meta["httpStatus"] = status
		}
	}
	return failure
}

func registrationProtocolFailure(stage string, status int) *diag.Diag {
	return registrationBoundaryFailure("KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", "The Gateway returned an invalid registration response.", stage, status)
}

func projectRegistrationFailure(platformRoot, projectRoot string, cause error) *diag.Diag {
	active, _ := receipt.Read(platformRoot)
	hint := projectRegistrationHint(active, projectRoot)
	causeCode := contracts.CodeProjectRegistrationFailed
	requestStage := "register"
	meta := map[string]any{"platformRoot": platformRoot, "projectRoot": projectRoot}
	var typed *diag.Diag
	if errors.As(cause, &typed) {
		causeCode = typed.Code
		if typed.Meta != nil {
			for _, key := range []string{"requestStage", "httpStatus", "remoteCorrelationId"} {
				if value, exists := typed.Meta[key]; exists {
					meta[key] = value
				}
			}
			if stage, ok := typed.Meta["requestStage"].(string); ok && stage != "" {
				requestStage = stage
			}
		}
	}
	var httpStatus *int
	if status, ok := meta["httpStatus"].(int); ok {
		httpStatus = &status
	}
	remoteCorrelationID, _ := meta["remoteCorrelationId"].(string)
	failure := contracts.NewProjectRegistrationFailure(requestStage, causeCode, httpStatus, remoteCorrelationID, hint)
	meta = failure.Meta
	meta["platformRoot"] = platformRoot
	meta["projectRoot"] = projectRoot
	failure.Meta = meta
	return failure
}
