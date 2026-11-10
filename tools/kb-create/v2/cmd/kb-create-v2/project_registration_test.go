package v2cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testprocess"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

type projectRegistrationTestClock struct{ now time.Time }

func (c projectRegistrationTestClock) Now() time.Time { return c.now }

type projectRegistrationTestHost struct {
	mu           sync.Mutex
	server       *httptest.Server
	gatewayProxy http.Handler
}

func (host *projectRegistrationTestHost) Start(_ context.Context, spec contracts.HostSpec) (func() error, error) {
	parsed, err := url.Parse(spec.HealthURL)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", parsed.Host)
	if err != nil {
		return nil, err
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health" {
			_, _ = fmt.Fprint(w, `{"ok":true}`)
			return
		}
		host.gatewayProxy.ServeHTTP(w, request)
	}))
	server.Listener = listener
	server.Start()
	host.mu.Lock()
	if host.server != nil {
		host.server.Close()
	}
	host.server = server
	host.mu.Unlock()
	return func() error { server.Close(); return nil }, nil
}

func (host *projectRegistrationTestHost) stop() {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.server != nil {
		host.server.Close()
		host.server = nil
	}
}

func (host *projectRegistrationTestHost) running() bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.server != nil
}

// case: S-187.12, S-222.12
func TestSecuredInstallRerunsDoNotCallGatewayForEitherRecordedSpelling(t *testing.T) {
	project := t.TempDir()
	selected := filepath.Join(t.TempDir(), "selected-project")
	if err := os.Symlink(project, selected); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	home, root := t.TempDir(), t.TempDir()
	t.Cleanup(func() {
		if err := makeTempTreeWritable(home); err != nil {
			t.Logf("make isolated HOME removable: %v", err)
		}
	})
	kbHome := filepath.Join(home, ".kb")
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", kbHome)

	realGateway := startSecuredProjectRegistrationGateway(t)
	upstream, err := url.Parse(realGateway)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	var requestsMu sync.Mutex
	requestCounts := map[string]int{"login": 0, "register": 0}
	var gatewayRequests []string
	refuseRegistration := false
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind := ""
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/auth/login/cli":
			kind = "login"
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/projects":
			kind = "register"
		}
		if kind != "" {
			requestsMu.Lock()
			requestCounts[kind]++
			refuse := refuseRegistration
			requestsMu.Unlock()
			if refuse {
				http.Error(w, "registration endpoint disabled after first install", http.StatusServiceUnavailable)
				return
			}
		}
		requestsMu.Lock()
		gatewayRequests = append(gatewayRequests, r.Method+" "+r.URL.Path)
		requestsMu.Unlock()
		proxy.ServeHTTP(w, r)
	}))
	defer proxyServer.Close()
	countingProxyTarget, err := url.Parse(proxyServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	countingProxy := httputil.NewSingleHostReverseProxy(countingProxyTarget)

	_, fakehost := binaries(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	hostSpec := &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	active := contracts.InstallReceipt{
		ID: "secured-install-before-project-registration",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
			Schema: contracts.RequestSchema, PlatformRoot: root, ProjectRoot: selected,
			Values: map[string]string{
				"gateway.access.mode":          `"secured"`,
				"gateway.bootstrap.adminEmail": `"admin@example.test"`,
				"gateway.bootstrap.tenantId":   `"workspace"`,
			},
		}},
		Verification: contracts.Verification{HostHealthURL: proxyServer.URL + "/health"},
	}
	active.Schema = contracts.ReceiptSchema
	active.Plan.Schema = contracts.ResolvedPlanSchema
	active.Plan.PlatformChannel = "stable"
	active.Plan.ServiceGraph = contracts.ServiceGraph{PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway"}}}
	active.Plan.Artifacts = []contracts.Artifact{{ID: "platform", Kind: "platform", Package: "@kb/platform", Version: "2.0.0"}}
	active.Plan.Host = hostSpec
	writeVersionedReceipt(t, root, active)
	const password = "bootstrap-password-for-test"
	if err := (secrets.Store{PlatformRoot: root}).Put("gateway.bootstrap.password", password); err != nil {
		t.Fatal(err)
	}
	registered, err := registerProject(root, selected)
	if err != nil || registered.CanonicalPath != canonical || registered.ID == "" {
		t.Fatalf("first secured project registration = %#v, err=%v", registered, err)
	}
	if _, err := recordProjectIdentity(root, selected, registered); err != nil {
		t.Fatal(err)
	}
	if requestCounts["login"] != 1 || requestCounts["register"] != 1 {
		t.Fatalf("first secured registration Gateway calls = login %d, register %d; want one each", requestCounts["login"], requestCounts["register"])
	}
	secretStore := secrets.Store{PlatformRoot: root}
	if err := secretStore.PutBootstrapPassword(password, secrets.BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	if err := secretStore.MarkBootstrapCompleted("true"); err != nil {
		t.Fatal(err)
	}
	if err := readBootstrapOutcome(context.Background(), realGateway+"/health", secretStore); err != nil {
		t.Fatalf("record first-admin completion from the secured Gateway auth-readiness route: %v", err)
	}
	activeRoot := projectReceiptRoot(root)
	cliBin := filepath.Join(activeRoot, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliBin, []byte("export {};\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	identityBefore, err := receipt.Read(activeRoot)
	if err != nil {
		t.Fatal(err)
	}
	unregisteredBeforeRepeat := identityBefore
	unregisteredBeforeRepeat.ProjectSelectedPath, unregisteredBeforeRepeat.ProjectID, unregisteredBeforeRepeat.ProjectCanonicalPath = "", "", ""
	if err := receipt.Write(activeRoot, unregisteredBeforeRepeat); err != nil {
		t.Fatal(err)
	}
	registryPath := filepath.Join(kbHome, "projects.json")
	registryBytesBefore, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	requestsMu.Lock()
	refuseRegistration = true
	requestCounts["login"], requestCounts["register"] = 0, 0
	gatewayRequests = nil
	requestsMu.Unlock()

	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	launcher := filepath.Join(home, "bin", "kb-create")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("launcher"), 0o755); err != nil {
		t.Fatal(err)
	}
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = hostSpec
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {
		PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: 4000}},
	}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{
		{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`},
		{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail", Default: `"admin@example.test"`},
		{ID: "gateway.bootstrap.tenantId", Path: "/gateway/bootstrap/tenantId", Default: `"workspace"`},
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: `{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:4000"}}}}`},
	}
	source.Plugins = []catalog.Component{{ID: "@kb-labs/commit", Version: "1.0.0", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	planInput, err := json.Marshal(unregisteredBeforeRepeat.Plan.Request)
	if err != nil {
		t.Fatal(err)
	}
	planned := transport.PlanWith(planInput, release, resolve.Options{})
	if !planned.OK {
		t.Fatalf("resolve repeat-install plan for the live-host fixture: %#v", planned.Error)
	}
	unregisteredBeforeRepeat.Plan = *planned.Plan
	unregisteredBeforeRepeat.Plan.Request.PlatformRoot = activeRoot
	unregisteredBeforeRepeat.Plan.ServiceGraph.Services[0].Port = port
	unregisteredBeforeRepeat.Verification.HostHealthURL = hostSpec.HealthURL
	if err := receipt.Write(activeRoot, unregisteredBeforeRepeat); err != nil {
		t.Fatal(err)
	}
	indexBytes, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, indexBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	registrarCalls := 0
	clock := projectRegistrationTestClock{now: time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)}
	activeRoot = platformRootForTest(t, root)
	runner, err := host.NewRunner(activeRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Start(context.Background()); err != nil {
		t.Fatalf("start real supervised test host: %v", err)
	}
	t.Cleanup(func() {
		if _, err := runner.Stop(context.Background()); err != nil {
			t.Errorf("stop real supervised test host: %v", err)
		}
	})
	initialStatus, err := runner.Status(context.Background())
	if err != nil || initialStatus.State != host.StateRunning || !initialStatus.Healthy {
		t.Fatalf("initial supervised host status = %#v, %v", initialStatus, err)
	}
	testHost := &projectRegistrationTestHost{gatewayProxy: countingProxy}
	t.Cleanup(testHost.stop)
	for _, projectPath := range []string{selected, canonical, ""} {
		_, storedPasswordPresent, err := secretStore.Get(secrets.BootstrapPassword)
		if err != nil {
			t.Fatal(err)
		}
		requestPath := filepath.Join(t.TempDir(), "request.json")
		request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root, ProjectRoot: projectPath,
			Values: map[string]string{
				"gateway.access.mode":          `"secured"`,
				"gateway.bootstrap.adminEmail": `"admin@example.test"`,
				"gateway.bootstrap.tenantId":   `"workspace"`,
			}}
		requestBytes, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		var stdout, stderr bytes.Buffer
		registrarCallsBefore := registrarCalls
		command := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
			deps := productionCommandDependencies(cmd)
			deps.NodeCheck = func() error { return nil }
			deps.Executable = launcher
			deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, release)}, Clock: clock}
			deps.ProjectRegistrar = func(platformRoot, selectedProject string) (projectRegistrationResult, error) {
				registrarCalls++
				return registerInstalledProject(platformRoot, selectedProject, nil)
			}
			return deps
		})
		args := []string{"install", "--json", "--index", indexPath, "--input", requestPath}
		code := clikitcommand.Execute(command, args, &stdout, &stderr)
		output := stdout.String() + stderr.String()
		requestsMu.Lock()
		loginCalls, registrationCalls := requestCounts["login"], requestCounts["register"]
		requestsMu.Unlock()
		if registrarCalls != registrarCallsBefore || loginCalls != 0 || registrationCalls != 0 {
			t.Fatalf("repeat install for %q made forbidden registration calls: registrar %d, Gateway login %d, registration %d", projectPath, registrarCalls-registrarCallsBefore, loginCalls, registrationCalls)
		}
		if code.Code() != 0 {
			t.Fatalf("secured repeat install for %q exit=%d output:\n%s", projectPath, code.Code(), output)
		}
		status, statusErr := runner.Status(context.Background())
		current, receiptErr := receipt.Read(activeRoot)
		if statusErr != nil || receiptErr != nil || status.State != host.StateRunning || !status.Healthy ||
			current.ID != identityBefore.ID || status.ReceiptID != identityBefore.ID {
			t.Fatalf("repeat apply changed the live host identity: status=%#v statusErr=%v receipt=%#v receiptErr=%v", status, statusErr, current, receiptErr)
		}
		if storedPasswordPresent {
			if strings.Count(output, password) != 1 || strings.Count(output, `"password":`) != 1 {
				t.Fatalf("completed but undisclosed repeat install must disclose the stored credential exactly once: %s", output)
			}
		} else if strings.Contains(output, `"password":`) || strings.Contains(output, `"Password":`) || strings.Contains(output, password) {
			t.Fatalf("previously disclosed repeat install returned a password: %s", output)
		}
		repeatResult := installResultFromJSONStream(t, stdout.String(), code.Code())
		humanOutput := renderInstall(repeatResult)
		if storedPasswordPresent {
			if !strings.Contains(humanOutput, "Password:") || strings.Count(humanOutput, password) != 1 {
				t.Fatalf("completed but undisclosed repeat install human result must disclose the stored credential once: %s", humanOutput)
			}
		} else if strings.Contains(humanOutput, "Password:") || strings.Contains(humanOutput, password) {
			t.Fatalf("previously disclosed repeat install human result returned a password: %s", humanOutput)
		}
		wantAdminState := firstAdminPreviouslyDisclosed
		if storedPasswordPresent {
			wantAdminState = firstAdminDisclosed
		}
		if repeatResult.FirstAdmin == nil || repeatResult.FirstAdmin.State != wantAdminState {
			t.Fatalf("completed repeat install first-admin state = %#v; want %s", repeatResult.FirstAdmin, wantAdminState)
		}
		logBytes, err := os.ReadFile(repeatResult.LogPath)
		if err != nil {
			t.Fatalf("read repeat-install transcript %q: %v", repeatResult.LogPath, err)
		}
		assertSecretAbsent(t, "repeat-install transcript", logBytes, password)
		receiptBytes, err := os.ReadFile(receipt.Path(activeRoot))
		if err != nil {
			t.Fatalf("read repeat-install receipt: %v", err)
		}
		assertSecretAbsent(t, "repeat-install receipt", receiptBytes, password)
		planBytes, err := json.Marshal(repeatResult.Receipt.Plan)
		if err != nil {
			t.Fatal(err)
		}
		assertSecretAbsent(t, "repeat-install plan", planBytes, password)
		if !strings.Contains(output, `"operation":"apply"`) {
			t.Fatalf("repeat install did not apply: %s", output)
		}
		if repeatResult.ProjectRegistrationNotice != "" {
			noticeGateway, err := gateway.OriginFromHealthURL(repeatResult.Receipt.Verification.HostHealthURL)
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{
				contracts.ShellCommand("kb", "auth", "login", "--gateway-url", noticeGateway, "--email", "admin@example.test"),
				contracts.ShellCommand("kb", "project", "add", projectPath),
				contracts.ShellCommand("kb", "project", "show", projectPath),
			} {
				if !strings.Contains(repeatResult.ProjectRegistrationNotice, command) {
					t.Fatalf("completed undisclosed project notice %q omitted command %q", repeatResult.ProjectRegistrationNotice, command)
				}
			}
		} else if !strings.Contains(output, `"projectId":"`+registered.ID+`"`) {
			t.Fatalf("repeat install did not return recorded project identity: %s", output)
		}
		if status.State != host.StateRunning || !status.Healthy {
			t.Fatalf("repeat install with %q did not leave the host running: %#v", projectPath, status)
		}
		response, err := http.Get(source.Platforms[0].Host.HealthURL)
		if err != nil {
			t.Fatalf("repeat install host health request failed: %v", err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("repeat install host health status = %d, want 200", response.StatusCode)
		}
		updated, err := receipt.Read(activeRoot)
		if err != nil {
			t.Fatal(err)
		}
		if repeatResult.ProjectRegistrationNotice != "" {
			if updated.ProjectSelectedPath != "" || updated.ProjectID != "" || updated.ProjectCanonicalPath != "" {
				t.Fatalf("unregistered completed repeat changed project identity: selected=%q id=%q canonical=%q", updated.ProjectSelectedPath, updated.ProjectID, updated.ProjectCanonicalPath)
			}
		} else if updated.ProjectSelectedPath != identityBefore.ProjectSelectedPath || updated.ProjectID != identityBefore.ProjectID || updated.ProjectCanonicalPath != identityBefore.ProjectCanonicalPath {
			t.Fatalf("repeat install changed recorded project identity: selected=%q id=%q canonical=%q", updated.ProjectSelectedPath, updated.ProjectID, updated.ProjectCanonicalPath)
		}
		for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
			if present, err := (secrets.Store{PlatformRoot: root}).Exists(name); err != nil || present {
				t.Fatalf("repeat install for %q restored bootstrap secret %q: present=%v err=%v", projectPath, name, present, err)
			}
		}
		if projectPath == selected && storedPasswordPresent {
			if _, err := recordProjectIdentity(root, selected, registered); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := runner.Stop(context.Background()); err != nil {
		t.Fatalf("stop real supervised test host before the remaining registration assertions: %v", err)
	}
	unregistered, err := receipt.Read(activeRoot)
	if err != nil {
		t.Fatal(err)
	}
	unregistered.ProjectSelectedPath, unregistered.ProjectID, unregistered.ProjectCanonicalPath = "", "", ""
	unregistered.Plan.Request.ProjectRoot = selected
	if err := receipt.Write(activeRoot, unregistered); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "unregistered-request.json")
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root, ProjectRoot: selected,
		Values: map[string]string{
			"gateway.access.mode":          `"secured"`,
			"gateway.bootstrap.adminEmail": `"admin@example.test"`,
			"gateway.bootstrap.tenantId":   `"workspace"`,
		}}
	requestBytes, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	var noticeStdout, noticeStderr bytes.Buffer
	registrarCallsBefore := registrarCalls
	noticeCommand := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
		deps := productionCommandDependencies(cmd)
		deps.NodeCheck = func() error { return nil }
		deps.Executable = launcher
		deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, release)}, Host: testHost, Clock: clock}
		deps.ProjectRegistrar = func(platformRoot, selectedProject string) (projectRegistrationResult, error) {
			registrarCalls++
			return registerInstalledProject(platformRoot, selectedProject, nil)
		}
		return deps
	})
	noticeCode := clikitcommand.Execute(noticeCommand,
		[]string{"install", "--json", "--index", indexPath, "--input", requestPath}, &noticeStdout, &noticeStderr).Code()
	noticeOutput := noticeStdout.String() + noticeStderr.String()
	if noticeCode != 0 {
		t.Fatalf("completed secured install for an unregistered project exit=%d output=%s", noticeCode, noticeOutput)
	}
	noticeResult := installResultFromJSONStream(t, noticeStdout.String(), noticeCode)
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		if present, err := (secrets.Store{PlatformRoot: root}).Exists(name); err != nil || present {
			t.Fatalf("completed install notice for an unregistered project restored bootstrap secret %q: present=%v err=%v", name, present, err)
		}
	}
	noticeGateway, err := gateway.OriginFromHealthURL(noticeResult.Receipt.Verification.HostHealthURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		contracts.ShellCommand("kb", "auth", "login", "--gateway-url", noticeGateway, "--email", "admin@example.test"),
		contracts.ShellCommand("kb", "project", "add", selected),
		contracts.ShellCommand("kb", "project", "show", selected),
	} {
		if !strings.Contains(noticeResult.ProjectRegistrationNotice, command) {
			t.Fatalf("unregistered-project notice %q omitted command %q", noticeResult.ProjectRegistrationNotice, command)
		}
	}
	requestsMu.Lock()
	loginCalls, registrationCalls := requestCounts["login"], requestCounts["register"]
	requestsMu.Unlock()
	if registrarCalls != registrarCallsBefore || loginCalls != 0 || registrationCalls != 0 {
		t.Fatalf("unregistered completed install calls = registrar %d, Gateway login %d, registration %d; want zero",
			registrarCalls-registrarCallsBefore, loginCalls, registrationCalls)
	}
	testHost.stop()

	activeLayout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	logsBefore, err := os.ReadDir(activeLayout.OperationLogsDir())
	if err != nil {
		t.Fatal(err)
	}
	logNamesBefore := make(map[string]struct{}, len(logsBefore))
	for _, entry := range logsBefore {
		logNamesBefore[entry.Name()] = struct{}{}
	}
	commitPackage := filepath.Join(activeRoot, "node_modules", "@kb", "commit")
	if err := os.MkdirAll(commitPackage, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(commitPackage, "package.json"), []byte(`{"name":"@kb/commit","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	hostListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gatewayListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = hostListener.Close()
		t.Fatal(err)
	}
	hostPort := hostListener.Addr().(*net.TCPAddr).Port
	gatewayPort := gatewayListener.Addr().(*net.TCPAddr).Port
	if err := hostListener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gatewayListener.Close(); err != nil {
		t.Fatal(err)
	}
	humanSource := testReleaseCatalog(t, "2.0.0")
	humanSource.Platforms[0].Host = &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", hostPort)}
	humanSource.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {
		PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: gatewayPort, Required: true}},
	}}
	humanSource.Platforms[0].Config = []catalog.ConfigRequirement{
		{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`},
		{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail", Default: `"admin@example.test"`},
		{ID: "gateway.bootstrap.tenantId", Path: "/gateway/bootstrap/tenantId", Default: `"workspace"`},
		{ID: "gateway.bootstrap.password", Path: "/gateway/bootstrap/password", Secret: true, Generate: true, Env: secrets.BootstrapPasswordEnvironment, Services: []string{"gateway"}},
		{ID: "gateway.jwtSecret", Path: "/gateway/jwtSecret", Secret: true, Generate: true, Env: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, gatewayPort)},
	}
	humanSource.Plugins = []catalog.Component{{ID: "@kb-labs/commit", Version: "1.0.0", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}}
	humanRelease, err := sealTestCatalog(t, humanSource)
	if err != nil {
		t.Fatal(err)
	}
	humanIndexPath := filepath.Join(t.TempDir(), "human-release-index.json")
	humanIndexBytes, err := json.Marshal(humanRelease)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(humanIndexPath, humanIndexBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	testHost.stop()
	var humanStdout, humanStderr bytes.Buffer
	humanRegistrarCallsBefore := registrarCalls
	humanJWTSecret := strings.Repeat("j", 32)
	humanCommand := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
		deps := productionCommandDependencies(cmd)
		deps.NodeCheck = func() error { return nil }
		deps.Marketplace = recordingMarketplaceInstaller{}
		deps.Executable = launcher
		answers := []string{"", "", "secured", "admin@example.test", "workspace", humanJWTSecret, humanJWTSecret, ""}
		deps.InstallInput = strings.NewReader(strings.Join(answers, "\n"))
		deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, humanRelease)}, Host: testHost, Clock: clock}
		deps.ProjectRegistrar = func(platformRoot, selectedProject string) (projectRegistrationResult, error) {
			registrarCalls++
			return registerInstalledProject(platformRoot, selectedProject, nil)
		}
		return deps
	})
	humanCode := clikitcommand.Execute(humanCommand,
		[]string{"install", "--index", humanIndexPath, "--platform-root", root, "--project-root", selected,
			"--gateway-url", fmt.Sprintf("http://127.0.0.1:%d", gatewayPort)},
		&humanStdout, &humanStderr)
	if humanCode.Code() != 0 {
		redact := func(value string) string {
			value = strings.ReplaceAll(value, password, "[redacted]")
			return strings.ReplaceAll(value, humanJWTSecret, "[redacted]")
		}
		t.Fatalf("human secured repeat install exit=%d; stdout=%s stderr=%s", humanCode.Code(), redact(humanStdout.String()), redact(humanStderr.String()))
	}
	if registrarCalls != humanRegistrarCallsBefore || requestCounts["login"] != 0 || requestCounts["register"] != 0 {
		t.Fatalf("human repeat install made registration calls: registrar %d, Gateway login %d, registration %d",
			registrarCalls-humanRegistrarCallsBefore, requestCounts["login"], requestCounts["register"])
	}
	if strings.Contains(humanStdout.String(), "Admin password:") {
		t.Fatal("completed secured install prompted again for the first-administrator password")
	}
	for label, output := range map[string][]byte{"human stdout": humanStdout.Bytes(), "human stderr": humanStderr.Bytes()} {
		if strings.Contains(string(output), "Password:") || strings.Contains(string(output), `"password"`) || strings.Contains(string(output), `"Password"`) {
			t.Fatalf("secured human repeat install %s contains a password label or field", label)
		}
		assertSecretAbsent(t, label+" from human repeat install", output, password)
	}
	registrationListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	registrationPort := registrationListener.Addr().(*net.TCPAddr).Port
	if err := registrationListener.Close(); err != nil {
		t.Fatal(err)
	}
	registrationHost := &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(registrationPort)},
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", registrationPort), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	source.Platforms[0].Host = registrationHost
	registrationRelease, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	registrationIndexBytes, err := json.Marshal(registrationRelease)
	if err != nil {
		t.Fatal(err)
	}
	registrationIndexPath := filepath.Join(t.TempDir(), "registration-release-index.json")
	if err := os.WriteFile(registrationIndexPath, registrationIndexBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	indexPath = registrationIndexPath
	identityBefore.Plan.Host = registrationHost
	identityBefore.Verification.HostHealthURL = registrationHost.HealthURL
	unregistered.Plan.Host = registrationHost
	unregistered.Verification.HostHealthURL = registrationHost.HealthURL
	logsAfter, err := os.ReadDir(activeLayout.OperationLogsDir())
	if err != nil {
		t.Fatal(err)
	}
	newLogCount := 0
	for _, entry := range logsAfter {
		if _, existed := logNamesBefore[entry.Name()]; existed || entry.IsDir() {
			continue
		}
		newLogCount++
		logBytes, readErr := os.ReadFile(filepath.Join(activeLayout.OperationLogsDir(), entry.Name()))
		if readErr != nil {
			t.Fatalf("read human repeat-install transcript: %v", readErr)
		}
		assertSecretAbsent(t, "human repeat-install transcript", logBytes, password)
	}
	if newLogCount == 0 {
		t.Fatal("human repeat install did not create an inspectable operation transcript")
	}
	requestsMu.Lock()
	loginCalls, registrationCalls = requestCounts["login"], requestCounts["register"]
	requestsDuringRepeats := append([]string(nil), gatewayRequests...)
	requestsMu.Unlock()
	if registrarCalls != 0 || loginCalls != 0 || registrationCalls != 0 || len(requestsDuringRepeats) != 0 {
		t.Fatalf("matching secured install calls = registrar %d, Gateway login %d, registration %d, other Gateway requests %v; want zero", registrarCalls, loginCalls, registrationCalls, requestsDuringRepeats)
	}
	registryBytesAfter, err := os.ReadFile(registryPath)
	if err != nil || !bytes.Equal(registryBytesBefore, registryBytesAfter) {
		t.Fatalf("matching install changed $KB_HOME/projects.json bytes: read err=%v", err)
	}
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		if present, err := (secrets.Store{PlatformRoot: root}).Exists(name); err != nil || present {
			completed, completedErr := (secrets.Store{PlatformRoot: root}).BootstrapCompleted()
			disclosed, disclosedErr := (secrets.Store{PlatformRoot: root}).BootstrapDisclosed()
			t.Fatalf("repeat install restored disclosed bootstrap secret %q: present %v, err %v; completed=%v/%v disclosed=%v/%v", name, present, err, completed, completedErr, disclosed, disclosedErr)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(activeRoot, ".kb"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(activeRoot, ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, commandName := range []string{"install", "apply", "update", "rollback"} {
		for _, recorded := range []bool{true, false} {
			label := commandName + "/unregistered"
			identity := unregistered
			if recorded {
				label = commandName + "/registered"
				identity = identityBefore
			}
			t.Run(label, func(t *testing.T) {
				if testHost.running() {
					testHost.stop()
				}
				probe, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
				if err != nil {
					t.Fatalf("project registration fixture left its Gateway port %d occupied: %v", port, err)
				}
				if err := probe.Close(); err != nil {
					t.Fatal(err)
				}
				identity.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway", Command: "gateway"}}
				if err := receipt.Write(activeRoot, identity); err != nil {
					t.Fatal(err)
				}
				var snapshotID string
				if commandName == "rollback" {
					snapshot, err := receipt.CreateSnapshot(activeRoot, activeLayout.SnapshotsDir(), clock.now)
					if err != nil {
						t.Fatal(err)
					}
					snapshotID = snapshot.ID
				}
				requestsMu.Lock()
				requestCounts["login"], requestCounts["register"] = 0, 0
				gatewayRequests = nil
				requestsMu.Unlock()
				args := []string{commandName, "--json", "--platform-root", root}
				switch commandName {
				case "install", "apply":
					args = []string{commandName, "--json", "--index", indexPath, "--input", requestPath}
				case "update":
					args = append(args, "--index", indexPath, "--input", requestPath)
				case "rollback":
					args = append(args, "--snapshot", snapshotID, "--yes")
				}
				command := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
					deps := productionCommandDependencies(cmd)
					deps.NodeCheck = func() error { return nil }
					deps.Executable = launcher
					deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, registrationRelease)}, Host: testHost, Clock: clock}
					return deps
				})
				var stdout, stderr bytes.Buffer
				code := clikitcommand.Execute(command, args, &stdout, &stderr).Code()
				output := stdout.String() + stderr.String()
				if code != 0 {
					t.Fatalf("completed %s exit=%d output=%s", label, code, output)
				}
				if recorded && strings.Contains(output, `"projectRegistrationNotice"`) {
					t.Fatalf("completed %s returned a project registration notice", label)
				}
				if !recorded {
					notice := ""
					if commandName == "install" {
						notice = installResultFromJSONStream(t, stdout.String(), code).ProjectRegistrationNotice
					} else if commandName == "apply" {
						notice = applyResultFromJSONDocument(t, stdout.String()).ProjectRegistrationNotice
					} else {
						var envelope struct {
							Data struct {
								ProjectRegistrationNotice string `json:"projectRegistrationNotice"`
							} `json:"data"`
						}
						if err := json.Unmarshal([]byte(output), &envelope); err != nil {
							t.Fatalf("completed %s result is not a JSON result: %v", label, err)
						}
						notice = envelope.Data.ProjectRegistrationNotice
					}
					current, err := receipt.Read(projectReceiptRoot(root))
					if err != nil {
						t.Fatal(err)
					}
					noticeGateway, err := gateway.OriginFromHealthURL(current.Verification.HostHealthURL)
					if err != nil {
						t.Fatal(err)
					}
					for _, command := range []string{
						contracts.ShellCommand("kb", "auth", "login", "--gateway-url", noticeGateway, "--email", "admin@example.test"),
						contracts.ShellCommand("kb", "project", "add", selected),
						contracts.ShellCommand("kb", "project", "show", selected),
					} {
						if !strings.Contains(notice, command) {
							t.Fatalf("completed %s notice omitted owner command %q: %s", label, command, notice)
						}
					}
				}
				requestsMu.Lock()
				loginCalls, registrationCalls := requestCounts["login"], requestCounts["register"]
				requests := append([]string(nil), gatewayRequests...)
				requestsMu.Unlock()
				if loginCalls != 0 || registrationCalls != 0 || len(requests) != 0 {
					t.Fatalf("completed %s made forbidden Gateway requests: login=%d registration=%d requests=%v", label, loginCalls, registrationCalls, requests)
				}
				for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
					if present, err := secretStore.Exists(name); err != nil || present {
						t.Fatalf("completed %s left bootstrap secret %s present=%v err=%v", label, name, present, err)
					}
				}
				assertSecretAbsentFromTree(t, root, password)
			})
		}
	}
}

func TestSecuredProjectRegistrationUsesTransientGatewayLogin(t *testing.T) {
	project := t.TempDir()
	projectAlias := filepath.Join(t.TempDir(), "selected-project")
	if err := os.Symlink(project, projectAlias); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	password := "bootstrap-password-for-test"
	origin := startSecuredProjectRegistrationGateway(t)
	canonicalProject, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}

	installed := contracts.InstallReceipt{
		ID: "receipt-test",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{Values: map[string]string{
			"gateway.access.mode":          `"secured"`,
			"gateway.bootstrap.adminEmail": `"admin@example.test"`,
			"gateway.bootstrap.tenantId":   `"workspace"`,
		}}},
		Verification: contracts.Verification{HostHealthURL: origin + "/health"},
	}
	if err := receipt.Write(root, installed); err != nil {
		t.Fatal(err)
	}
	if err := (secrets.Store{PlatformRoot: root}).Put("gateway.bootstrap.password", password); err != nil {
		t.Fatal(err)
	}
	homeBefore := snapshotFilesystem(t, home)
	rootBefore := snapshotFilesystem(t, root)
	registered, err := registerProject(root, projectAlias)
	if err != nil || registered.ID == "" || registered.CanonicalPath != canonicalProject || registered.AlreadyExisted {
		var failure *diag.Diag
		_ = errors.As(err, &failure)
		t.Fatalf("registration identity/error = %#v / %v (diagnostic=%#v)", registered, err, failure)
	}
	activeReceipt, err := recordProjectIdentity(root, projectAlias, registered)
	if err != nil || activeReceipt.ProjectSelectedPath != projectAlias || activeReceipt.ProjectID != registered.ID || activeReceipt.ProjectCanonicalPath != canonicalProject {
		t.Fatalf("receipt project identity = %#v, err=%v", activeReceipt, err)
	}
	for _, path := range []string{filepath.Join(home, ".kb/session.json"), filepath.Join(home, ".kb/credentials.json")} {
		if _, err := os.Stat(path); err == nil {
			t.Fatalf("registration persisted a CLI session at %s", path)
		}
	}
	if data, err := os.ReadFile(receipt.Path(root)); err != nil || strings.Contains(string(data), password) ||
		strings.Contains(string(data), "accessToken") || strings.Contains(string(data), "refreshToken") {
		t.Fatalf("receipt read/error or authentication material persisted: %v", err)
	}
	if stored, present, err := (secrets.Store{PlatformRoot: root}).Get("gateway.bootstrap.password"); err != nil || !present || stored != password {
		t.Fatalf("bootstrap password state changed: present=%v err=%v", present, err)
	}
	homeChanges := changedFilesystemPaths(homeBefore, snapshotFilesystem(t, home))
	rootChanges := changedFilesystemPaths(rootBefore, snapshotFilesystem(t, root))
	kbHome := filepath.Join(home, ".kb")
	for _, path := range homeChanges {
		allowed, err := allowedProjectRegistrationHomePath(home, path, registered.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Errorf("project registration changed unapproved HOME path %q", path)
		}
	}
	relativeReceipt, err := filepath.Rel(root, receipt.Path(root))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range rootChanges {
		if path != relativeReceipt {
			t.Errorf("project registration changed unapproved install-root path %q", path)
		}
	}
	if !containsPath(homeChanges, filepath.Join(".kb", "projects.json")) {
		t.Fatalf("project registry file was not recorded as the sole registration write: HOME=%v", homeChanges)
	}
	registryData, err := os.ReadFile(filepath.Join(kbHome, "projects.json"))
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Projects []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(registryData, &registry); err != nil || len(registry.Projects) != 1 ||
		registry.Projects[0].ID != registered.ID || registry.Projects[0].Path != canonicalProject {
		t.Fatalf("approved project registry write = %#v, err=%v", registry, err)
	}
}

func allowedProjectRegistrationHomePath(home, path, projectID string) (bool, error) {
	allowed := map[string]bool{
		filepath.Join(".kb"):                     true,
		filepath.Join(".kb", "projects.json"):    true,
		filepath.Join(".kb", "state"):            true,
		filepath.Join(".kb", "state", projectID): true,
	}
	if allowed[path] {
		return true, nil
	}
	return contracts.PathWithin(filepath.Join(home, ".kb", "state", projectID), filepath.Join(home, path))
}

func containsPath(paths []string, expected string) bool {
	for _, path := range paths {
		if path == expected {
			return true
		}
	}
	return false
}

func snapshotFilesystem(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		value := info.Mode().String()
		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += ":" + link
		} else if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += fmt.Sprintf(":%x:%d", sha256.Sum256(data), info.ModTime().UnixNano())
		}
		snapshot[relative] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func changedFilesystemPaths(before, after map[string]string) []string {
	changed := make([]string, 0)
	for path, prior := range before {
		if current, exists := after[path]; !exists || current != prior {
			changed = append(changed, path)
		}
	}
	for path := range after {
		if _, existed := before[path]; !existed {
			changed = append(changed, path)
		}
	}
	sort.Strings(changed)
	return changed
}

func TestSecuredGatewayFixtureReportsMissingBuildArtifact(t *testing.T) {
	missingRoot := t.TempDir()
	err := requireSecuredGatewayFixtureBuildArtifacts(missingRoot)
	if err == nil || !strings.Contains(err.Error(), filepath.Join(missingRoot, "core", "project-registry", "dist", "index.js")) ||
		!strings.Contains(err.Error(), "corepack pnpm -r --filter '@kb-labs/gateway-app...'") {
		t.Fatalf("missing artifact diagnostic = %v", err)
	}
	moduleFailure := "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@kb-labs/host-app' imported from fixture.ts"
	if got := missingSecuredGatewayFixtureModule(moduleFailure + "\n    at file:///fixture.ts"); got != moduleFailure {
		t.Fatalf("missing module classifier = %q, want %q", got, moduleFailure)
	}
}

func makeTempTreeWritable(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o700)
		}
		return nil
	})
}

const securedGatewayFixtureBuildCommand = "corepack pnpm -r --filter '@kb-labs/gateway-app...' --filter '@kb-labs/host-app...' --filter '@kb-labs/core-project-registry...' --workspace-concurrency=2 build"

func requireSecuredGatewayFixtureBuildArtifacts(workspaceRoot string) error {
	registryEntry := filepath.Join(workspaceRoot, "core", "project-registry", "dist", "index.js")
	if _, err := os.Stat(registryEntry); err != nil {
		return fmt.Errorf("secured Gateway fixture is missing built artifact %s; run `%s`", registryEntry, securedGatewayFixtureBuildCommand)
	}
	return nil
}

func startSecuredProjectRegistrationGateway(t *testing.T) string {
	t.Helper()
	workspaceRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := requireSecuredGatewayFixtureBuildArtifacts(workspaceRoot); err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(workspaceRoot, "services", "gateway", "app", "test-fixtures", "secured-project-registration-gateway.ts")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	tsRunner := filepath.Join(workspaceRoot, "services", "gateway", "app", "node_modules", ".bin", "tsx")
	command := exec.CommandContext(ctx, tsRunner, fixture)
	command.Dir = workspaceRoot
	command.Env = os.Environ()
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var stderr testprocess.Buffer
	command.Stderr = &stderr
	startTestProcessGroup(t, command)
	t.Cleanup(func() {
		cancel()
		if stderr.Len() > 0 {
			t.Logf("secured Gateway fixture stderr: %s", stderr.String())
		}
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		if missing := missingSecuredGatewayFixtureModule(stderr.String()); missing != "" {
			t.Fatalf("secured Gateway fixture could not load built input %s; run `%s`", missing, securedGatewayFixtureBuildCommand)
		}
		t.Fatalf("secured Gateway fixture did not become ready: %v", err)
	}
	fields := strings.Fields(line)
	if len(fields) != 2 || fields[0] != "READY" {
		t.Fatalf("secured Gateway fixture readiness = %q; stderr: %s", line, stderr.String())
	}
	return fields[1]
}

func missingSecuredGatewayFixtureModule(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "Cannot find module") || strings.Contains(line, "Cannot find package") || strings.Contains(line, "ERR_MODULE_NOT_FOUND") {
			return line
		}
	}
	return ""
}

// case: S-224.1, S-224.2
func TestRegistrationFailuresNeverCopyRemoteTextIntoDiagnostics(t *testing.T) {
	const password = "x18-bootstrap-password-marker"
	const token = "x18-access-token-marker"
	const installerCorrelationID = "fedcba9876543210fedcba9876543210"
	tests := []struct {
		name      string
		causeCode string
		stage     string
		status    int
	}{
		{"login refused", "KB_AUTH_INVALID_CREDENTIALS", "login", http.StatusUnauthorized},
		{"login malformed", "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", "login", http.StatusUnauthorized},
		{"login transport error", "KB_AUTH_GATEWAY_UNREACHABLE", "login", 0},
		{"register refused", "KB_AUTH_FORBIDDEN", "register", http.StatusForbidden},
		{"register malformed", "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", "register", http.StatusBadGateway},
		{"register transport error", "KB_HOST_UNREACHABLE", "register", 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root, home, project := t.TempDir(), t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			var requestIDMu sync.Mutex
			var lastRequestID string
			responseWithSecrets := func(w http.ResponseWriter, status int, code, requestID string) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Remote-Credential", password+" "+token)
				w.WriteHeader(status)
				if code == "" {
					_, _ = io.WriteString(w, `{"error":"`+password+" "+token+`"`)
					return
				}
				catalog, ok := diag.LookupCatalog(code)
				if !ok {
					t.Fatalf("test code %q is absent from the platform catalog", code)
				}
				details := make(map[string]string, len(catalog.TemplateParameters))
				for _, name := range catalog.TemplateParameters {
					details[name] = "machine:register"
				}
				body, err := json.Marshal(map[string]any{"ok": false, "error": map[string]any{
					"code": code, "area": catalog.Area, "stage": catalog.Stage, "severity": catalog.Severity, "retryable": catalog.Retryable,
					"message": password + " " + token, "hint": token + " " + password,
					"cause": password + " " + token, "correlationId": requestID,
					"details": details,
				}})
				if err != nil {
					t.Fatal(err)
				}
				var payload struct{}
				decoded, decodeErr := result.DecodeResultWithContext(body, &payload, result.RemoteFailureContext{RequestStage: test.stage, HTTPStatus: status})
				if decodeErr != nil || decoded == nil || decoded.Code != code {
					t.Fatalf("shared decoder did not preserve catalogued code: code=%q failure=%#v err=%v", code, decoded, decodeErr)
				}
				_, _ = w.Write(body)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestID := r.Header.Get("X-Request-Id")
				if !diag.IsValidCorrelationID(requestID) {
					t.Errorf("request correlation ID = %q, want valid Gateway correlation ID", requestID)
				}
				requestIDMu.Lock()
				lastRequestID = requestID
				requestIDMu.Unlock()
				if r.URL.Path == "/auth/login/cli" {
					if test.name == "login transport error" {
						connection, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						_, _ = fmt.Fprintf(connection, "invalid-response %s %s\r\n\r\n", password, token)
						_ = connection.Close()
						return
					}
					if test.stage == "login" {
						if test.name == "login malformed" {
							responseWithSecrets(w, test.status, "", requestID)
						} else {
							responseWithSecrets(w, test.status, "KB_AUTH_INVALID_CREDENTIALS", requestID)
						}
						return
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = fmt.Fprintf(w, `{"ok":true,"data":{"accessToken":%q,"refreshToken":%q,"expiresIn":3600,"tenantId":"workspace"}}`, token, token)
					return
				}
				if test.name == "register transport error" {
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_, _ = fmt.Fprintf(connection, "invalid-response %s %s\r\n\r\n", password, token)
					_ = connection.Close()
					return
				}
				if test.name == "register malformed" {
					responseWithSecrets(w, test.status, "", requestID)
					return
				}
				responseWithSecrets(w, test.status, "KB_AUTH_FORBIDDEN", requestID)
			}))
			defer server.Close()

			active := contracts.InstallReceipt{ID: "failed-receipt", Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{Values: map[string]string{
				"gateway.access.mode":          `"secured"`,
				"gateway.bootstrap.adminEmail": `"admin@example.test"`,
				"gateway.bootstrap.tenantId":   `"workspace"`,
			}}}, Verification: contracts.Verification{HostHealthURL: server.URL + "/health"}}
			if err := receipt.Write(root, active); err != nil {
				t.Fatal(err)
			}
			if err := (secrets.Store{PlatformRoot: root}).Put("gateway.bootstrap.password", password); err != nil {
				t.Fatal(err)
			}
			secretStore := secrets.Store{PlatformRoot: root}
			_, cause := registerProject(root, project)
			if cause == nil {
				t.Fatal("registration failure unexpectedly succeeded")
			}
			failure := projectRegistrationFailure(root, project, cause)
			statusMatches := test.status == 0 && failure.Meta["httpStatus"] == nil ||
				test.status != 0 && failure.Meta["httpStatus"] == test.status
			if failure.Code != "KB_INSTALL_PROJECT_REGISTRATION_FAILED" || failure.Meta["causeCode"] != test.causeCode ||
				failure.Meta["requestStage"] != test.stage || !statusMatches {
				t.Fatalf("registration diagnostic metadata = %#v", failure.Meta)
			}
			if failure.Cause == "" || !strings.Contains(failure.Cause, "failed during "+test.stage) || !strings.Contains(failure.Cause, test.causeCode) {
				t.Fatalf("registration diagnostic cause = %q", failure.Cause)
			}
			failure.CorrelationID = installerCorrelationID
			remoteCorrelationID, hasRemoteCorrelationID := failure.Meta["remoteCorrelationId"]
			wantRemoteCorrelationID := test.name == "login refused" || test.name == "register refused"
			requestIDMu.Lock()
			gatewayCorrelationID := lastRequestID
			requestIDMu.Unlock()
			if hasRemoteCorrelationID != wantRemoteCorrelationID || (wantRemoteCorrelationID && remoteCorrelationID != gatewayCorrelationID) {
				t.Fatalf("remote correlation metadata = %#v, want present=%v value=%q", remoteCorrelationID, wantRemoteCorrelationID, gatewayCorrelationID)
			}
			var jsonOutput, humanOutput bytes.Buffer
			result.RenderDiag(&jsonOutput, &humanOutput, failure, result.ModeJSON)
			result.RenderDiag(&bytes.Buffer{}, &humanOutput, failure, result.ModeHuman)
			if wantRemoteCorrelationID {
				var envelope struct {
					Error struct {
						CorrelationID string         `json:"correlationId"`
						Cause         string         `json:"cause"`
						Details       map[string]any `json:"details"`
					} `json:"error"`
				}
				if err := json.Unmarshal(jsonOutput.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if envelope.Error.CorrelationID != installerCorrelationID ||
					envelope.Error.Details["remoteCorrelationId"] != gatewayCorrelationID ||
					!strings.Contains(envelope.Error.Cause, "Gateway correlation ID "+gatewayCorrelationID) ||
					!strings.Contains(humanOutput.String(), "correlationId: "+installerCorrelationID) ||
					!strings.Contains(humanOutput.String(), "remote correlationId: "+gatewayCorrelationID) {
					t.Fatalf("diagnostic outputs did not retain distinct installer and Gateway IDs: json=%s human=%s", jsonOutput.String(), humanOutput.String())
				}
			}
			for _, secret := range []string{password, token} {
				if strings.Contains(failure.Message+failure.Hint+failure.Reason+failure.Cause, secret) ||
					strings.Contains(jsonOutput.String(), secret) || strings.Contains(humanOutput.String(), secret) {
					t.Fatalf("remote secret %q reached a diagnostic or renderer", secret)
				}
			}
			passwordFiles := 0
			for _, path := range []string{root, home} {
				err := filepath.WalkDir(path, func(file string, entry os.DirEntry, walkErr error) error {
					if walkErr != nil || entry.IsDir() {
						return walkErr
					}
					data, err := os.ReadFile(file)
					if err != nil {
						return err
					}
					if bytes.Contains(data, []byte(token)) {
						return fmt.Errorf("file %s contains a remote token", file)
					}
					if bytes.Contains(data, []byte(password)) {
						passwordFiles++
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if passwordFiles != 1 {
				t.Fatalf("registration failure left the password in %d files, want only its owner record", passwordFiles)
			}
			if stored, present, err := secretStore.Get("gateway.bootstrap.password"); err != nil || !present || stored != password {
				t.Fatal("registration failure changed the bootstrap password state")
			}
		})
	}
}

// case: S-224.1
func TestProjectPathRemovedAfterApplyRetainsCataloguedCause(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(t.TempDir(), "removed-after-apply")
	_, cause := registerInstalledProject(root, missing, nil)
	var typed *diag.Diag
	if !errors.As(cause, &typed) || typed.Code != "KB_PROJECT_PATH_NOT_FOUND" {
		t.Fatalf("missing path cause = %#v", cause)
	}
	failure := projectRegistrationFailure(root, missing, cause)
	if failure.Meta["causeCode"] != "KB_PROJECT_PATH_NOT_FOUND" {
		t.Fatalf("registration failure did not preserve the path cause: %#v", failure.Meta)
	}
}

// case: S-187.11
func TestExistingInstallationRejectsDifferentProjectBeforeApply(t *testing.T) {
	root := t.TempDir()
	activeProject := t.TempDir()
	selectedProject := t.TempDir()
	active := contracts.InstallReceipt{ID: "receipt-existing", ProjectSelectedPath: activeProject, ProjectID: "prj_0123456789abcdef", ProjectCanonicalPath: activeProject, Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
		PlatformRoot: root, ProjectRoot: activeProject,
	}}}
	writeVersionedReceipt(t, root, active)
	existing, failure := existingProjectSelection(platformRootForTest(t, root), selectedProject)
	if !existing || failure == nil || failure.Code != "KB_INSTALL_PROJECT_SELECTION_CHANGED" ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "add", selectedProject)) ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "show", selectedProject)) {
		t.Fatalf("existing/failure = %v / %#v", existing, failure)
	}
	if _, failure := existingProjectSelection(platformRootForTest(t, root), ""); failure != nil {
		t.Fatalf("empty project selection refused: %v", failure)
	}
}

// case: S-222.11
func TestExistingInstallRetriesRegistrationForTheRecordedSelection(t *testing.T) {
	root := t.TempDir()
	selectedProject := t.TempDir()
	active := contracts.InstallReceipt{ID: "receipt-registration-pending", Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
		PlatformRoot: root, ProjectRoot: selectedProject,
	}}}
	writeVersionedReceipt(t, root, active)
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	physicalRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{root, layout.PlatformRoot(), physicalRoot} {
		existing, failure := existingProjectSelection(spelling, selectedProject)
		if existing || failure != nil {
			t.Fatalf("retry selection through %q = existing %v, failure %#v; want apply and retry registration", spelling, existing, failure)
		}
	}
}

// case: S-187.11
func TestExistingApplyRejectsDifferentProjectBeforeOperation(t *testing.T) {
	root := t.TempDir()
	activeProject := t.TempDir()
	selectedProject := t.TempDir()
	active := contracts.InstallReceipt{ID: "receipt-existing", ProjectSelectedPath: activeProject, ProjectID: "prj_0123456789abcdef", ProjectCanonicalPath: activeProject, Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
		PlatformRoot: root, ProjectRoot: activeProject,
	}}}
	writeVersionedReceipt(t, root, active)
	resolved := resolvedPlan{Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{
		PlatformRoot: root, ProjectRoot: selectedProject,
	}}}
	_, failure := applyPlan(context.Background(), applyCommandInput{Resolved: &resolved}, commandDependencies{
		NodeCheck: func() error { return nil },
	})
	if failure == nil || failure.Code != "KB_INSTALL_PROJECT_SELECTION_CHANGED" ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "add", selectedProject)) ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "show", selectedProject)) {
		t.Fatalf("apply selection failure = %#v", failure)
	}
}

// case: S-187.11
func TestExistingProjectSelectionRejectsAliasEvenWhenItTargetsRecordedProject(t *testing.T) {
	root := t.TempDir()
	project := t.TempDir()
	alias := filepath.Join(t.TempDir(), "same-project-alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	active := contracts.InstallReceipt{ID: "receipt-existing", ProjectSelectedPath: project,
		ProjectID: "prj_0123456789abcdef", ProjectCanonicalPath: project,
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root, ProjectRoot: project}}}
	writeVersionedReceipt(t, root, active)
	beforeRoot := snapshotFilesystem(t, root)
	existing, failure := existingProjectSelection(platformRootForTest(t, root), alias)
	if !existing || failure == nil || failure.Code != contracts.CodeProjectSelectionChanged {
		t.Fatalf("existing/failure = %v / %#v, want changed selection", existing, failure)
	}
	if strings.Contains(strings.ToLower(failure.Message), "different project") || !strings.Contains(failure.Message, "path spelling differs") {
		t.Fatalf("selection refusal overstates project identity: %q", failure.Message)
	}
	if !strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "add", alias)) ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "show", alias)) {
		t.Fatalf("alias settling hint = %q", failure.Hint)
	}
	if changes := changedFilesystemPaths(beforeRoot, snapshotFilesystem(t, root)); len(changes) != 0 {
		t.Fatalf("changed selection mutated the install root: %v", changes)
	}
}

// case: S-187.12
func TestExistingProjectSelectionAcceptsEitherRecordedSpelling(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	alias := filepath.Join(t.TempDir(), "project-alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Fatal(err)
	}
	active := contracts.InstallReceipt{ID: "receipt-existing", ProjectSelectedPath: alias,
		ProjectID: "prj_0123456789abcdef", ProjectCanonicalPath: target,
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root, ProjectRoot: alias}}}
	writeVersionedReceipt(t, root, active)
	for _, selected := range []string{alias, target} {
		existing, failure := existingProjectSelection(platformRootForTest(t, root), selected)
		if !existing || failure != nil {
			t.Fatalf("selection %q existing/failure = %v / %#v", selected, existing, failure)
		}
	}
}

// case: S-224.3
func TestExistingProjectSelectionDiagnosesReceiptWithoutIdentityFields(t *testing.T) {
	root := t.TempDir()
	project := t.TempDir()
	legacyReceipt := contracts.InstallReceipt{Schema: "kb.create.receipt/v2", ID: "receipt-legacy",
		Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root, ProjectRoot: project}}}
	data, err := json.Marshal(legacyReceipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(receipt.Path(root)), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receipt.Path(root), data, 0o600); err != nil {
		t.Fatal(err)
	}
	existing, failure := existingProjectSelection(root, project)
	if existing || failure == nil || failure.Code != contracts.CodeReceiptUnavailable ||
		!strings.Contains(failure.Message, "receipt schema") ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)) ||
		!strings.Contains(failure.Hint, "reinstall") {
		t.Fatalf("legacy receipt diagnosis = existing %v, failure %#v", existing, failure)
	}
}
