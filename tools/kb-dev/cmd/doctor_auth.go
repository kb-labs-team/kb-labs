package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/kb-labs/dev/internal/manager"
)

// authIssue and authReadiness mirror AuthReadiness from
// services/gateway/auth/src/auth-readiness.ts, as served by the gateway's
// GET /health/auth. The gateway owns the knowledge (it reads its own stores);
// doctor only surfaces it, so no document-database format is duplicated here.
type authIssue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Hint     string `json:"hint"`
}

type authReadiness struct {
	// OK is a pointer so a body that is JSON but not an auth-readiness
	// document (wrong route, proxy error page) is rejected instead of being
	// read as "ok: false, no issues".
	OK           *bool       `json:"ok"`
	AuthEnabled  bool        `json:"authEnabled"`
	TenantID     string      `json:"tenantId"`
	ActiveAdmins int         `json:"activeAdmins"`
	Bootstrap    string      `json:"bootstrap"`
	Issues       []authIssue `json:"issues"`
}

// fetchAuthReadiness asks the local gateway for its auth readiness. It returns
// (readiness, "") on success or (nil, reason) when the answer is unavailable —
// which is never a doctor failure by itself: an older gateway has no such
// route, and the route deliberately answers 404 to anything but a local,
// unproxied operator.
func fetchAuthReadiness(baseURL string) (*authReadiness, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/health/auth", nil)
	if err != nil {
		return nil, "auth readiness request could not be built"
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "gateway not running — auth check skipped"
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return nil, "gateway does not expose /health/auth (older version, or request not local) — auth check skipped"
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Sprintf("gateway returned HTTP %d for /health/auth — auth check skipped", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, "failed to read auth readiness response"
	}
	var readiness authReadiness
	if err := json.Unmarshal(body, &readiness); err != nil || readiness.OK == nil {
		return nil, "unexpected /health/auth response — auth check skipped"
	}
	return &readiness, ""
}

// authChecks turns a readiness document into doctor checks. Errors fail the
// doctor; warnings are reported (Warn) but leave it passing. The returned hint
// is the fix for the first error, for the doctor's summary line.
func authChecks(r *authReadiness) (checks []manager.DoctorCheck, hint string, ok bool) {
	ok = r.OK != nil && *r.OK
	summary := manager.DoctorCheck{ID: "auth", OK: ok}
	if r.AuthEnabled {
		summary.Detail = fmt.Sprintf("enabled, %d active admin(s), tenant %s", r.ActiveAdmins, r.TenantID)
	} else {
		summary.Detail = "disabled (local mode, no login)"
	}
	checks = append(checks, summary)

	for _, issue := range r.Issues {
		isWarning := issue.Severity == "warning" // anything unrecognised counts as an error
		detail := issue.Message
		if issue.Hint != "" {
			detail += " Fix: " + issue.Hint
		}
		checks = append(checks, manager.DoctorCheck{ID: "auth:" + issue.Code, OK: isWarning, Warn: isWarning, Detail: detail})
		if !isWarning && hint == "" {
			hint = issue.Hint
		}
	}
	return checks, hint, ok
}

// addAuthChecks queries the local gateway and appends the auth checks to the
// doctor result, failing it on errors. It returns the skip reason ("" when the
// check ran).
func addAuthChecks(result *manager.DoctorResult, gatewayPort int) string {
	port := 4000
	if gatewayPort > 0 {
		port = gatewayPort
	}
	readiness, skip := fetchAuthReadiness(fmt.Sprintf("http://localhost:%d", port))
	if readiness == nil {
		return skip
	}
	checks, hint, ok := authChecks(readiness)
	result.Checks = append(result.Checks, checks...)
	if !ok {
		result.OK = false
		if result.Hint == "" {
			result.Hint = hint
		}
	}
	return ""
}
