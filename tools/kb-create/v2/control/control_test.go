package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
)

// fixturesDir is shared with the future TS client; see its README.
const fixturesDir = "../../../../core/platform/src/launcher-control/fixtures/v1"

type fakeRunner struct {
	mu      sync.Mutex
	calls   []string
	startEr error
}

func (f *fakeRunner) Name() string { return "process" }
func (f *fakeRunner) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}
func (f *fakeRunner) Start(context.Context) (host.Info, error) {
	f.record("start")
	return host.Info{Runner: "process", PID: 4243, HealthURL: "http://127.0.0.1:1/health"}, f.startEr
}
func (f *fakeRunner) Stop(context.Context) (host.StopResult, error) {
	f.record("stop")
	return host.StopResult{Runner: "process", WasRunning: true, Graceful: true, PID: 4242}, nil
}
func (f *fakeRunner) Status(context.Context) (host.Status, error) {
	started := time.Now().UTC()
	return host.Status{Runner: "process", State: host.StateRunning, PID: 4242, Healthy: true, HealthURL: "http://127.0.0.1:1/health", StartedAt: &started}, nil
}

func startServer(t *testing.T) (*Server, *fakeRunner, host.State) {
	t.Helper()
	runner := &fakeRunner{}
	state := host.State{Dir: filepath.Join(t.TempDir(), "state")}
	server := &Server{Runner: runner, State: state, Version: "9.9.9-test"}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server, runner, state
}

func call(t *testing.T, server *Server, method, path, token string, body any, headers map[string]string) (int, []byte, http.Header) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, "http://"+server.Address()+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		if key == "Host" {
			request.Host = value // net/http ignores a Host entry in Header
			continue
		}
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data, response.Header
}

func TestControlFileIsPrivateAndDescribesTheServer(t *testing.T) {
	server, _, state := startServer(t)
	info, err := os.Stat(state.Control())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("control.json mode %v, want 0600", info.Mode().Perm())
	}
	data, _ := os.ReadFile(state.Control())
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.Protocol != 1 || file.Address != server.Address() || file.Token != server.Token() || file.PID != os.Getpid() || file.Version != "9.9.9-test" {
		t.Fatalf("control.json: %+v", file)
	}
	if !strings.HasPrefix(file.Address, "127.0.0.1:") || len(file.Token) < 64 {
		t.Fatalf("address/token shape: %+v", file)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(state.Control()); !os.IsNotExist(err) {
		t.Fatal("control.json must be removed on close")
	}
}

func TestTokenRejection(t *testing.T) {
	server, runner, _ := startServer(t)
	cases := map[string]struct {
		token   string
		headers map[string]string
	}{
		"missing token":            {},
		"wrong token":              {token: "nope"},
		"prefix of the real token": {token: server.Token()[:10]},
		"token with suffix":        {token: server.Token() + "x"},
		"basic scheme":             {headers: map[string]string{"Authorization": "Basic " + server.Token()}},
		"browser origin":           {token: server.Token(), headers: map[string]string{"Origin": "http://evil.example"}},
		"rebound host header":      {token: server.Token(), headers: map[string]string{"Host": "evil.example"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			for _, endpoint := range []struct{ method, path string }{{"GET", "/v1/status"}, {"POST", "/v1/host/restart"}, {"POST", "/v1/update-request"}, {"GET", "/nope"}} {
				status, body, _ := call(t, server, endpoint.method, endpoint.path, tc.token, nil, tc.headers)
				if status != http.StatusUnauthorized || !strings.Contains(string(body), "KB_HOST_CONTROL_UNAUTHORIZED") {
					t.Fatalf("%s %s: status %d body %s", endpoint.method, endpoint.path, status, body)
				}
			}
		})
	}
	if len(runner.calls) != 0 {
		t.Fatalf("rejected requests must not reach the runner: %v", runner.calls)
	}
}

func TestNoCORSHeaders(t *testing.T) {
	server, _, _ := startServer(t)
	for _, token := range []string{"", server.Token()} {
		_, _, header := call(t, server, http.MethodOptions, "/v1/status", token, nil, nil)
		for key := range header {
			if strings.HasPrefix(strings.ToLower(key), "access-control-") {
				t.Fatalf("unexpected CORS header %s", key)
			}
		}
	}
}

func TestListenerIsLoopbackOnly(t *testing.T) {
	server, _, _ := startServer(t)
	if !strings.HasPrefix(server.Address(), "127.0.0.1:") {
		t.Fatalf("address %s", server.Address())
	}
}

func TestRestartStopsThenStarts(t *testing.T) {
	server, runner, _ := startServer(t)
	status, _, _ := call(t, server, http.MethodPost, "/v1/host/restart", server.Token(), nil, nil)
	if status != http.StatusOK || !reflect.DeepEqual(runner.calls, []string{"stop", "start"}) {
		t.Fatalf("status %d calls %v", status, runner.calls)
	}
}

func TestRestartFailureUsesTheEnvelope(t *testing.T) {
	server, runner, _ := startServer(t)
	runner.startEr = contracts.NewLauncherError("KB_HOST_PORT_IN_USE", "Port 1 is used by another application.", "Free the port.", nil)
	status, body, _ := call(t, server, http.MethodPost, "/v1/host/restart", server.Token(), nil, nil)
	if status != http.StatusInternalServerError || !strings.Contains(string(body), "KB_HOST_PORT_IN_USE") {
		t.Fatalf("status %d body %s", status, body)
	}
}

func TestUpdateRequestValidation(t *testing.T) {
	server, _, _ := startServer(t)
	invalid := []any{
		map[string]any{},
		map[string]any{"version": "1.0.0", "channel": "stable"},
		map[string]any{"version": "latest"},
		map[string]any{"channel": "nightly"},
		map[string]any{"channel": "stable", "unknown": true},
		map[string]any{"channel": "stable", "requestedBy": strings.Repeat("x", 65)},
	}
	for _, body := range invalid {
		status, data, _ := call(t, server, http.MethodPost, "/v1/update-request", server.Token(), body, nil)
		if status != http.StatusBadRequest || !strings.Contains(string(data), "KB_RUNTIME_INPUT_INVALID") {
			t.Fatalf("%v: status %d body %s", body, status, data)
		}
	}
	status, _, _ := call(t, server, http.MethodPost, "/v1/update-request", server.Token(), nil, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("empty body: status %d", status)
	}
}

func TestUpdateRequestQueuePersistsDedupesAndBounds(t *testing.T) {
	server, _, state := startServer(t)
	post := func(body map[string]any) (int, UpdateRequestResponse) {
		status, data, _ := call(t, server, http.MethodPost, "/v1/update-request", server.Token(), body, nil)
		var out UpdateRequestResponse
		_ = json.Unmarshal(data, &out)
		return status, out
	}
	status, first := post(map[string]any{"channel": "stable"})
	if status != http.StatusAccepted || first.Request.Status != "pending" || first.Request.ID == "" {
		t.Fatalf("first: %d %+v", status, first)
	}
	_, again := post(map[string]any{"channel": "stable"})
	if again.Request.ID != first.Request.ID {
		t.Fatal("an identical pending request must be returned, not duplicated")
	}
	info, err := os.Stat(state.UpdateRequests())
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("queue file: %v %v", info, err)
	}
	for i := 0; i < maxPending-1; i++ {
		if status, _ := post(map[string]any{"version": fmt.Sprintf("1.0.%d", i)}); status != http.StatusAccepted {
			t.Fatalf("request %d: %d", i, status)
		}
	}
	if status, _ := post(map[string]any{"version": "2.0.0"}); status != http.StatusTooManyRequests {
		t.Fatalf("full queue: %d", status)
	}
	_, statusBody, _ := call(t, server, http.MethodGet, "/v1/status", server.Token(), nil, nil)
	var summary StatusResponse
	_ = json.Unmarshal(statusBody, &summary)
	if summary.UpdateRequests.Pending != maxPending {
		t.Fatalf("pending %d", summary.UpdateRequests.Pending)
	}
}

func TestClientRoundTrip(t *testing.T) {
	server, _, state := startServer(t)
	client, err := Connect(state)
	if err != nil {
		t.Fatal(err)
	}
	status, err := client.Status(context.Background())
	if err != nil || status.Host.PID != 4242 || status.Launcher.Version != "9.9.9-test" {
		t.Fatalf("status: %+v %v", status, err)
	}
	restart, err := client.Restart(context.Background())
	if err != nil || restart.Host.PID != 4243 {
		t.Fatalf("restart: %+v %v", restart, err)
	}
	accepted, err := client.RequestUpdate(context.Background(), UpdateRequestInput{Channel: "canary"})
	if err != nil || accepted.Request.Channel != "canary" {
		t.Fatalf("update: %+v %v", accepted, err)
	}
	_, err = client.RequestUpdate(context.Background(), UpdateRequestInput{})
	var typed *contracts.LauncherError
	if !errors.As(err, &typed) || typed.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("invalid update: %v", err)
	}
	client.File.Token = "wrong"
	if _, err := client.Status(context.Background()); !errors.As(err, &typed) || typed.Code != "KB_HOST_CONTROL_UNAUTHORIZED" {
		t.Fatalf("wrong token: %v", err)
	}
	_ = server
}

func TestConnectIgnoresControlFileOfDeadLauncher(t *testing.T) {
	state := host.State{Dir: t.TempDir()}
	data, _ := json.Marshal(File{Protocol: 1, Address: "127.0.0.1:1", Token: "t", PID: 2147483646, Version: "x"})
	_ = os.WriteFile(state.Control(), data, 0o600)
	_, err := Connect(state)
	var typed *contracts.LauncherError
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_CONTROL_UNAVAILABLE" {
		t.Fatalf("connect: %v", err)
	}
	if _, err := Connect(host.State{Dir: t.TempDir()}); err == nil {
		t.Fatal("missing control.json must be unavailable")
	}
}

// ---- contract test: replay the shared JSON fixtures ----

type exchange struct {
	Description string `json:"description"`
	Request     struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Auth   string `json:"auth"`
		Body   any    `json:"body"`
	} `json:"request"`
	Response struct {
		Status int `json:"status"`
		Body   any `json:"body"`
	} `json:"response"`
	File any `json:"file"`
}

func TestSharedProtocolFixtures(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixturesDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no fixtures found in %s", fixturesDir)
	}
	sort.Strings(files)
	for _, path := range files {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture exchange
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			server, _, state := startServer(t)
			if fixture.File != nil {
				raw, _ := os.ReadFile(state.Control())
				var actual any
				_ = json.Unmarshal(raw, &actual)
				matchFixture(t, "control.json", fixture.File, actual)
				return
			}
			token := map[string]string{"valid": server.Token(), "wrong": "not-the-token", "none": ""}[fixture.Request.Auth]
			status, body, _ := call(t, server, fixture.Request.Method, fixture.Request.Path, token, fixture.Request.Body, nil)
			if status != fixture.Response.Status {
				t.Fatalf("status %d, fixture says %d; body %s", status, fixture.Response.Status, body)
			}
			var actual any
			if err := json.Unmarshal(body, &actual); err != nil {
				t.Fatal(err)
			}
			matchFixture(t, "body", fixture.Response.Body, actual)
		})
	}
}

// matchFixture compares actual against expected, where "$string", "$number"
// and "$iso8601" are matchers (see the fixtures README). Objects must have
// exactly the expected keys, so an added or removed field is a contract break.
func matchFixture(t *testing.T, where string, expected, actual any) {
	t.Helper()
	switch want := expected.(type) {
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			t.Fatalf("%s: expected an object, got %T", where, actual)
		}
		for key := range got {
			if _, known := want[key]; !known {
				t.Errorf("%s: unexpected key %q", where, key)
			}
		}
		for key, value := range want {
			actualValue, present := got[key]
			if !present {
				t.Errorf("%s: missing key %q", where, key)
				continue
			}
			matchFixture(t, where+"."+key, value, actualValue)
		}
	case string:
		switch want {
		case "$string":
			if text, ok := actual.(string); !ok || text == "" {
				t.Errorf("%s: expected a non-empty string, got %v", where, actual)
			}
		case "$number":
			if _, ok := actual.(float64); !ok {
				t.Errorf("%s: expected a number, got %v", where, actual)
			}
		case "$iso8601":
			text, _ := actual.(string)
			if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
				t.Errorf("%s: expected an RFC 3339 timestamp, got %v", where, actual)
			}
		default:
			if actual != want {
				t.Errorf("%s: got %v, want %v", where, actual, want)
			}
		}
	default:
		if !reflect.DeepEqual(expected, actual) {
			t.Errorf("%s: got %v, want %v", where, actual, expected)
		}
	}
}
