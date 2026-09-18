package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kb-labs/dev/internal/manager"
)

func serve(t *testing.T, status int, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health/auth" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

const lockedOut = `{"ok":false,"authEnabled":true,"tenantId":"kblabs-cloud","activeAdmins":0,"bootstrap":"not-configured","issues":[
  {"code":"no_active_admin","severity":"error","message":"no admin","hint":"kb auth reset-admin --email a@b.c --tenant kblabs-cloud --generate --yes"}]}`

const healthy = `{"ok":true,"authEnabled":true,"tenantId":"kblabs-cloud","activeAdmins":2,"bootstrap":"exists-active","issues":[]}`

func find(checks []manager.DoctorCheck, id string) *manager.DoctorCheck {
	for i := range checks {
		if checks[i].ID == id {
			return &checks[i]
		}
	}
	return nil
}

func TestFetchAuthReadiness_ParsesAReadinessDocument(t *testing.T) {
	r, skip := fetchAuthReadiness(serve(t, 200, lockedOut))
	if skip != "" || r == nil {
		t.Fatalf("want readiness, got skip=%q", skip)
	}
	if r.OK == nil || *r.OK || r.ActiveAdmins != 0 || len(r.Issues) != 1 || r.Issues[0].Code != "no_active_admin" {
		t.Fatalf("parsed wrongly: %+v", r)
	}
}

func TestFetchAuthReadiness_SkipsRatherThanFailsWhenUnavailable(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"older gateway or non-local request (404)", 404, `{"error":"Not Found"}`, "does not expose /health/auth"},
		{"server error", 500, `oops`, "HTTP 500"},
		{"not JSON", 200, `<html>bad gateway</html>`, "unexpected /health/auth response"},
		{"JSON but not a readiness document", 200, `{"status":"ok"}`, "unexpected /health/auth response"},
		{"empty object", 200, `{}`, "unexpected /health/auth response"},
		{"JSON array (e.g. the adapters route)", 200, `[]`, "unexpected /health/auth response"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, skip := fetchAuthReadiness(serve(t, tc.status, tc.body))
			if r != nil || !strings.Contains(skip, tc.want) {
				t.Fatalf("want skip containing %q, got readiness=%v skip=%q", tc.want, r, skip)
			}
		})
	}
}

func TestFetchAuthReadiness_GatewayDown(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // now nothing listens there

	r, skip := fetchAuthReadiness(url)
	if r != nil || !strings.Contains(skip, "gateway not running") {
		t.Fatalf("want 'gateway not running' skip, got %v %q", r, skip)
	}
}

func TestAuthChecks_LockedOutFailsWithTheFix(t *testing.T) {
	r, _ := fetchAuthReadiness(serve(t, 200, lockedOut))
	checks, hint, ok := authChecks(r)

	if ok {
		t.Fatal("a locked-out install must not be ok")
	}
	if c := find(checks, "auth"); c == nil || c.OK || !strings.Contains(c.Detail, "0 active admin") {
		t.Fatalf("summary check wrong: %+v", c)
	}
	issue := find(checks, "auth:no_active_admin")
	if issue == nil || issue.OK || issue.Warn || !strings.Contains(issue.Detail, "Fix: kb auth reset-admin") {
		t.Fatalf("issue check wrong: %+v", issue)
	}
	if !strings.HasPrefix(hint, "kb auth reset-admin") {
		t.Fatalf("hint should be the fix, got %q", hint)
	}
}

func TestAuthChecks_HealthyIsASingleGreenCheck(t *testing.T) {
	r, _ := fetchAuthReadiness(serve(t, 200, healthy))
	checks, hint, ok := authChecks(r)
	if !ok || hint != "" || len(checks) != 1 || !checks[0].OK || !strings.Contains(checks[0].Detail, "2 active admin") {
		t.Fatalf("healthy should be one ok check: ok=%v hint=%q checks=%+v", ok, hint, checks)
	}
}

func TestAuthChecks_DisabledModeIsOKAndSaysSo(t *testing.T) {
	r, _ := fetchAuthReadiness(serve(t, 200, `{"ok":true,"authEnabled":false,"tenantId":"t","activeAdmins":0,"bootstrap":"not-configured","issues":[]}`))
	checks, _, ok := authChecks(r)
	if !ok || !strings.Contains(checks[0].Detail, "disabled") {
		t.Fatalf("disabled mode should pass and be labelled: %+v", checks)
	}
}

func TestAuthChecks_WarningDoesNotFailTheDoctor(t *testing.T) {
	r, _ := fetchAuthReadiness(serve(t, 200, `{"ok":true,"authEnabled":true,"tenantId":"t","activeAdmins":1,"bootstrap":"exists-active","issues":[
	  {"code":"jwt_secret_default","severity":"warning","message":"dev secret","hint":"set GATEWAY_JWT_SECRET"}]}`))
	checks, hint, ok := authChecks(r)

	if !ok || hint != "" {
		t.Fatalf("a warning must neither fail nor set the summary hint: ok=%v hint=%q", ok, hint)
	}
	w := find(checks, "auth:jwt_secret_default")
	if w == nil || !w.OK || !w.Warn {
		t.Fatalf("warning check should be OK+Warn: %+v", w)
	}
}

func TestAuthChecks_UnknownSeverityIsTreatedAsAnError(t *testing.T) {
	r, _ := fetchAuthReadiness(serve(t, 200, `{"ok":false,"authEnabled":true,"tenantId":"t","activeAdmins":1,"bootstrap":"x","issues":[
	  {"code":"future_thing","severity":"critical","message":"m","hint":"h"}]}`))
	checks, hint, _ := authChecks(r)
	if c := find(checks, "auth:future_thing"); c == nil || c.OK {
		t.Fatalf("unknown severity must fail closed: %+v", c)
	}
	if hint != "h" {
		t.Fatalf("hint = %q", hint)
	}
}

func TestAddAuthChecks_FailsTheDoctorAndKeepsAnExistingHint(t *testing.T) {
	t.Run("locked out → doctor fails, hint is the fix", func(t *testing.T) {
		result := &manager.DoctorResult{OK: true}
		port := portOf(t, serve(t, 200, lockedOut))
		if skip := addAuthChecks(result, port); skip != "" {
			t.Fatalf("unexpected skip %q", skip)
		}
		if result.OK || !strings.HasPrefix(result.Hint, "kb auth reset-admin") {
			t.Fatalf("doctor should fail with the fix as hint: %+v", result)
		}
	})
	t.Run("does not overwrite an earlier hint", func(t *testing.T) {
		result := &manager.DoctorResult{OK: false, Hint: "Port 4000 occupied"}
		addAuthChecks(result, portOf(t, serve(t, 200, lockedOut)))
		if result.Hint != "Port 4000 occupied" {
			t.Fatalf("hint clobbered: %q", result.Hint)
		}
	})
	t.Run("healthy leaves the doctor passing", func(t *testing.T) {
		result := &manager.DoctorResult{OK: true}
		addAuthChecks(result, portOf(t, serve(t, 200, healthy)))
		if !result.OK || result.Hint != "" {
			t.Fatalf("healthy must not change the verdict: %+v", result)
		}
	})
	t.Run("unavailable is skipped, never a failure", func(t *testing.T) {
		result := &manager.DoctorResult{OK: true}
		skip := addAuthChecks(result, portOf(t, serve(t, 404, `{}`)))
		if skip == "" || !result.OK || len(result.Checks) != 0 {
			t.Fatalf("skip=%q result=%+v", skip, result)
		}
	})
}

func portOf(t *testing.T, url string) int {
	t.Helper()
	var port int
	idx := strings.LastIndex(url, ":")
	for _, c := range url[idx+1:] {
		port = port*10 + int(c-'0')
	}
	return port
}
