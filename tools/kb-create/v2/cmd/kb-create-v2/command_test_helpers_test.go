package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testprocess"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

func registerTestHostProcessTreeCleanup(t *testing.T, platformRoot string) {
	t.Helper()
	t.Cleanup(func() {
		state, err := host.StateForRoot(platformRoot)
		if err != nil {
			t.Errorf("resolve test host state for cleanup: %v", err)
			return
		}
		_, hostRecordErr := os.Stat(state.HostPID())
		_, supervisorRecordErr := os.Stat(state.SupervisorPID())
		if errors.Is(hostRecordErr, os.ErrNotExist) && errors.Is(supervisorRecordErr, os.ErrNotExist) {
			return
		}
		if hostRecordErr != nil && !errors.Is(hostRecordErr, os.ErrNotExist) {
			t.Errorf("inspect test host process record during cleanup: %v", hostRecordErr)
			return
		}
		if supervisorRecordErr != nil && !errors.Is(supervisorRecordErr, os.ErrNotExist) {
			t.Errorf("inspect test supervisor process record during cleanup: %v", supervisorRecordErr)
			return
		}
		hostRecord, hostAlive := host.ActiveHost(state)
		supervisorRecord, supervisorAlive := supervisor.ReadRecord(state)
		runner, err := host.NewRecordedRunner(platformRoot)
		if err != nil {
			t.Errorf("load recorded test host for process-tree cleanup: %v", err)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		command := hostCommand{PlatformRoot: platformRoot}
		if _, failure := command.stop(ctx, runner, runner.State); failure != nil {
			t.Errorf("stop test host process tree during cleanup: %v", failure)
			terminateTestProcessGroup(t, hostRecord.PID, hostRecord.ProcessIdentity, hostAlive)
			terminateTestProcessGroup(t, supervisorRecord.PID, supervisorRecord.ProcessIdentity, supervisorAlive)
		}
		status, err := runner.Status(ctx)
		if err != nil {
			t.Errorf("verify stopped test host during cleanup: %v", err)
			return
		}
		if status.State == host.StateRunning || status.PID != 0 && host.ProcessAlive(status.PID) {
			t.Errorf("test host process tree remains alive after cleanup: state=%s pid=%d", status.State, status.PID)
		}
		if record, alive := supervisor.ReadRecord(state); alive {
			t.Errorf("test supervisor process remains alive after cleanup: pid=%d", record.PID)
		}
	})
}

func terminateTestProcessGroup(t *testing.T, pid int, identity string, recorded bool) {
	t.Helper()
	if !recorded {
		return
	}
	if host.TerminateProcessGroupIfIdentity(pid, identity) {
		deadline := time.Now().Add(5 * time.Second)
		for host.ProcessAlive(pid) && time.Now().Before(deadline) {
			time.Sleep(25 * time.Millisecond)
		}
	}
	if host.ProcessAlive(pid) && !host.KillProcessGroupIfIdentity(pid, identity) {
		t.Errorf("could not terminate recorded test process group %d", pid)
	}
	if host.ProcessAlive(pid) {
		t.Errorf("test process group %d remains alive after forced cleanup", pid)
	}
}

func writeVersionedReceipt(t *testing.T, root string, installed contracts.InstallReceipt) {
	t.Helper()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	installed.InstallationID, err = versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	version := installed.Plan.ServiceGraph.PlatformVersion
	if version == "" {
		version = "1.0.0"
	}
	if _, err := layout.ActivateInitial(stage, version, installed.Plan.PlanHash); err != nil {
		t.Fatal(err)
	}
}

func assertEmptyOrMissing(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if os.IsNotExist(err) {
		return
	}
	if err != nil || len(entries) != 0 {
		t.Fatalf("directory %s contains entries after a read-only operation: %v, %v", path, entries, err)
	}
}

var allocatedTestPorts = struct {
	sync.Mutex
	ports map[int]struct{}
}{ports: make(map[int]struct{})}

func freeLoopbackPortWithOffset(t *testing.T, offset int) int {
	return freeLoopbackPortWithOffsets(t, offset)
}

func freeLoopbackPortWithOffsets(t *testing.T, offsets ...int) int {
	return freeLoopbackPortWithOffsetsInRange(t, 50000, 10001, offsets...)
}

// freeLoopbackPortWithOffsetsOutsideEphemeralRange reserves fixture allocations
// below the conventional Linux and macOS ephemeral-port ranges. Service ports
// derived from these Gateway URLs must not overlap transient outbound sockets.
func freeLoopbackPortWithOffsetsOutsideEphemeralRange(t *testing.T, offsets ...int) int {
	return freeLoopbackPortWithOffsetsInRange(t, 24000, 1024, offsets...)
}

// freeAllocatedGatewayPortWithOffsets reserves an address from the same
// stepped domain used by gateway.Registry, together with each derived port.
func freeAllocatedGatewayPortWithOffsets(t *testing.T, offsets ...int) int {
	t.Helper()
	for port := gateway.AllocatedGatewayPortMin; port <= gateway.AllocatedGatewayPortMax; port += gateway.AllocatedGatewayPortStep {
		if reserveLoopbackPortWithOffsets(t, port, offsets...) {
			return port
		}
	}
	t.Fatalf("could not reserve an allocated Gateway port in %d..%d by %d with offsets %v",
		gateway.AllocatedGatewayPortMin, gateway.AllocatedGatewayPortMax, gateway.AllocatedGatewayPortStep, offsets)
	return 0
}

func TestAllocatedGatewayFixturePortUsesRegistryDomain(t *testing.T) {
	port := freeAllocatedGatewayPortWithOffsets(t, gateway.AllocatedGatewayPortStep)
	if port < gateway.AllocatedGatewayPortMin || port > gateway.AllocatedGatewayPortMax ||
		(port-gateway.AllocatedGatewayPortMin)%gateway.AllocatedGatewayPortStep != 0 {
		t.Fatalf("fixture Gateway port %d is outside registry domain %d..%d by %d",
			port, gateway.AllocatedGatewayPortMin, gateway.AllocatedGatewayPortMax, gateway.AllocatedGatewayPortStep)
	}
	if port+gateway.AllocatedGatewayPortStep > gateway.AllocatedGatewayPortMax {
		t.Fatalf("fixture Gateway port %d leaves no domain slot for its required next allocation", port)
	}
}

func freeLoopbackPortWithOffsetsInRange(t *testing.T, first, last int, offsets ...int) int {
	t.Helper()
	for port := first; port >= last && portOffsetsFit(port, offsets); port-- {
		if reserveLoopbackPortWithOffsets(t, port, offsets...) {
			return port
		}
	}
	t.Fatalf("could not reserve a free Gateway port and its service offsets %v", offsets)
	return 0
}

func reserveLoopbackPortWithOffsets(t *testing.T, port int, offsets ...int) bool {
	t.Helper()
	if !portOffsetsFit(port, offsets) {
		return false
	}
	uniqueOffsets := make([]int, 0, len(offsets)+1)
	seenOffsets := map[int]struct{}{0: {}}
	uniqueOffsets = append(uniqueOffsets, 0)
	for _, offset := range offsets {
		if _, exists := seenOffsets[offset]; exists {
			continue
		}
		seenOffsets[offset] = struct{}{}
		uniqueOffsets = append(uniqueOffsets, offset)
	}
	allocatedTestPorts.Lock()
	alreadyAllocated := false
	for _, offset := range uniqueOffsets {
		if _, exists := allocatedTestPorts.ports[port+offset]; exists {
			alreadyAllocated = true
			break
		}
	}
	if alreadyAllocated {
		allocatedTestPorts.Unlock()
		return false
	}
	listeners := make([]net.Listener, 0, len(uniqueOffsets))
	for _, offset := range uniqueOffsets {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port+offset))
		if err != nil {
			for _, opened := range listeners {
				_ = opened.Close()
			}
			allocatedTestPorts.Unlock()
			return false
		}
		listeners = append(listeners, listener)
	}
	var closeErr error
	for _, listener := range listeners {
		if err := listener.Close(); err != nil {
			closeErr = errors.Join(closeErr, err)
		}
	}
	if closeErr != nil {
		allocatedTestPorts.Unlock()
		t.Fatal(closeErr)
	}
	for _, offset := range uniqueOffsets {
		allocatedTestPorts.ports[port+offset] = struct{}{}
	}
	allocatedTestPorts.Unlock()
	return true
}

func portOffsetsFit(port int, offsets []int) bool {
	for _, offset := range offsets {
		if port+offset < 1 || port+offset > 65535 {
			return false
		}
	}
	return true
}

func assertServicePortsAvoidDefaultGraph(t *testing.T, graph contracts.ServiceGraph, defaultServices []contracts.Service) {
	t.Helper()
	defaultPorts := make(map[int]struct{}, len(defaultServices))
	for _, service := range defaultServices {
		if service.Port != 0 {
			defaultPorts[service.Port] = struct{}{}
		}
	}
	for _, service := range graph.Services {
		if _, isDefault := defaultPorts[service.Port]; isDefault {
			t.Errorf("service %s retained a fixed default service port %d", service.ID, service.Port)
		}
	}
}

func startTestProcessGroup(t *testing.T, command *exec.Cmd) {
	t.Helper()
	if err := testprocess.Start(t, command); err != nil {
		t.Fatalf("start test process group: %v", err)
	}
}

func platformRootForTest(t *testing.T, installRoot string) string {
	t.Helper()
	layout, err := versionroot.New(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	return layout.PlatformRoot()
}

// operationTestSetup is a test-only fixture for supplying typed command inputs
// and dependency seams. Production code receives command-local typed inputs.
type operationTestSetup struct {
	Operation, Index, Input, DoctorInput, PlatformRoot, Snapshot, Registry, SecretEnv string
	Fix                                                                               bool
	Recover                                                                           recoverRequest
	ScenarioID, ScenarioAnswers                                                       string
	ScenarioResume                                                                    bool
	Direct                                                                            directRequest
	Executable                                                                        string
	Foreground, JSON, Yes                                                             bool
	InstallInput                                                                      io.Reader
	InstallOutput                                                                     io.Writer
	RuntimeDeps                                                                       *runtime.Dependencies
	Marketplace                                                                       marketplace.InstallClient
	NodePreflight                                                                     func() error
	ProjectRegistrar                                                                  func(string) (projectRegistrationResult, error)
}

func executeForTest(t *testing.T, setup operationTestSetup) (any, *diag.Diag, int, string) {
	t.Helper()
	descriptor, ok := lookupOperationDescriptor(setup.Operation)
	if !ok {
		t.Fatalf("command %q is not registered", setup.Operation)
	}
	var stdout bytes.Buffer
	cmd := &cobra.Command{Use: "kb-create " + setup.Operation}
	cmd.SetOut(&stdout)
	cmd.Flags().Bool("json", setup.JSON, "emit machine-readable output")
	values := make(map[string]any, len(descriptor.Flags))
	registerLocalFlags(cmd, descriptor.Flags, values)
	reader := newCommandFlagReader(cmd, values)
	setTestFlagValues(t, setup, reader)
	deps := commandDependencies{Runtime: setup.RuntimeDeps, NodeCheck: setup.NodePreflight,
		InstallInput: setup.InstallInput, InstallOutput: setup.InstallOutput, Marketplace: setup.Marketplace,
		Command: cmd, Executable: setup.Executable}
	if deps.Runtime == nil {
		deps.Runtime = &runtime.Dependencies{}
	}
	if deps.NodeCheck == nil {
		deps.NodeCheck = func() error { return nil }
	}
	deps.ProjectRegistrar = func(root, project string) (projectRegistrationResult, error) {
		return registerInstalledProject(root, project, setup.ProjectRegistrar)
	}
	data, failure := descriptor.Handler(context.Background(), cmd, reader, deps)
	if failure != nil {
		return nil, failure, diag.ExitCode(failure).Code(), stdout.String()
	}
	if completion, ok := data.(streamCompletion); ok {
		return nil, nil, completion.ExitStatus.Code(), stdout.String()
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return data, nil, 0, string(encoded)
}

func setTestFlagValues(t *testing.T, setup operationTestSetup, reader *commandFlagReader) {
	if t != nil {
		t.Helper()
	}
	setupValue := reflect.ValueOf(setup)
	directValue := reflect.ValueOf(setup.Direct)
	recoverValue := reflect.ValueOf(setup.Recover)
	for _, name := range operationFlags(setup.Operation) {
		value := reader.values[name]
		var source reflect.Value
		switch name {
		case "platform-root":
			source = setupValue.FieldByName("PlatformRoot")
			if directValue.FieldByName("PlatformRoot").String() != "" {
				source = directValue.FieldByName("PlatformRoot")
			}
		case "project-root":
			source = directValue.FieldByName("ProjectRoot")
		case "platform-version":
			source = directValue.FieldByName("PlatformVersion")
		case "platform-channel":
			source = directValue.FieldByName("PlatformChannel")
		case "gateway-url":
			source = directValue.FieldByName("GatewayURL")
		case "sdk-version":
			source = directValue.FieldByName("SDKVersion")
		case "service-profile":
			source = directValue.FieldByName("ServiceProfile")
		case "plugins":
			source = directValue.FieldByName("Plugins")
		case "adapters":
			source = directValue.FieldByName("Adapters")
		case "provider":
			source = directValue.FieldByName("Providers")
		case "policy":
			source = directValue.FieldByName("Policy")
		case "offline":
			source = directValue.FieldByName("Offline")
		case "scenario":
			source = setupValue.FieldByName("ScenarioID")
		case "fix":
			source = setupValue.FieldByName("Fix")
		case "recover":
			source = recoverValue.FieldByName("Enabled")
		case "yes":
			if setup.Operation == "doctor" {
				source = recoverValue.FieldByName("Yes")
			} else {
				source = setupValue.FieldByName("Yes")
			}
		case "resume":
			source = setupValue.FieldByName("ScenarioResume")
		case "email":
			source = recoverValue.FieldByName("Email")
		case "tenant":
			source = recoverValue.FieldByName("Tenant")
		case "password-stdin":
			source = recoverValue.FieldByName("PasswordStdin")
		case "generate":
			source = recoverValue.FieldByName("Generate")
		default:
			source = setupValue.FieldByName(flagFieldName(name))
		}
		if !source.IsValid() {
			continue
		}
		switch target := value.(type) {
		case *string:
			if source.Kind() == reflect.String {
				*target = source.String()
			}
		case *bool:
			if source.Kind() == reflect.Bool {
				*target = source.Bool()
			}
		case *repeatedValue:
			if source.Kind() == reflect.String && source.String() != "" {
				*target = strings.Split(source.String(), ",")
			}
		}
	}
}

func flagFieldName(flag string) string {
	parts := strings.Split(flag, "-")
	for i := range parts {
		parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
	}
	return strings.Join(parts, "")
}

func operationFlags(name string) []string {
	for _, descriptor := range operationDescriptors {
		if descriptor.Name == name {
			return descriptor.Flags
		}
	}
	return nil
}

func descriptorTestCall(cmd *cobra.Command, descriptor operationDescriptor, setup operationTestSetup) error {
	cmd.Flags().Bool("json", setup.JSON, "emit machine-readable output")
	values := make(map[string]any, len(descriptor.Flags))
	registerLocalFlags(cmd, descriptor.Flags, values)
	reader := newCommandFlagReader(cmd, values)
	setTestFlagValues(nil, setup, reader)
	deps := commandDependencies{Runtime: setup.RuntimeDeps, NodeCheck: setup.NodePreflight,
		InstallInput: setup.InstallInput, InstallOutput: setup.InstallOutput, Command: cmd, Executable: setup.Executable}
	if deps.Runtime == nil {
		deps.Runtime = &runtime.Dependencies{}
	}
	if deps.NodeCheck == nil {
		deps.NodeCheck = func() error { return nil }
	}
	deps.ProjectRegistrar = func(root, project string) (projectRegistrationResult, error) {
		return registerInstalledProject(root, project, setup.ProjectRegistrar)
	}
	return callDescriptor(cmd, descriptor, values, deps)
}

func invoke(t *testing.T, input operationTestSetup) (map[string]any, int, string) {
	t.Helper()
	data, failure, code, output := executeForTest(t, input)
	if failure != nil {
		encoded, err := json.Marshal(result.FailureEnvelope(failure))
		if err != nil {
			t.Fatal(err)
		}
		output = string(encoded)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		t.Fatalf("command output is not JSON: %v: %s", err, output)
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	if _, exists := parsed["ok"]; !exists && failure == nil && data != nil {
		parsed["ok"] = true
	}
	return parsed, code, output
}
