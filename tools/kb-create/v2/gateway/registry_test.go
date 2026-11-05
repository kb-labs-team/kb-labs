package gateway

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestJourneySchema2FixtureRoundTripsThroughRegistryReaderAndWriter(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "..", "e2e", "journey", "testdata", "gateway-roots-schema2.json")
	original, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(t.TempDir(), "gateway-roots.json")
	if err := os.WriteFile(input, original, 0o600); err != nil {
		t.Fatal(err)
	}
	roots, err := (Registry{Path: input}).readFile()
	if err != nil {
		t.Fatalf("strict reader rejected shared journey fixture: %v", err)
	}
	if len(roots) != 1 || roots[0].PlatformRoot == "" || !validInstallationID(roots[0].InstallationID) || !validOrigin(roots[0].URL) {
		t.Fatalf("shared fixture roots = %#v, want one complete schema-2 root", roots)
	}

	output := filepath.Join(t.TempDir(), "gateway-roots.json")
	if err := (Registry{Path: output}).write(roots); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, original) {
		t.Fatalf("shared journey fixture differs from Registry.write output:\nfixture:\n%s\nwriter:\n%s", original, actual)
	}
}

func TestRegisterForTransactionRestoresExactRegistryAndActiveReceiptOnCommitFailure(t *testing.T) {
	root, active, _ := installedRootSpellings(t, filepath.Join(t.TempDir(), "platform"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateway-roots.json"), OperationRoot: root}
	if err := registry.Writer(Apply).Register(root, "http://127.0.0.1:4100"); err != nil {
		t.Fatal(err)
	}
	registryBefore, err := os.ReadFile(registry.Path)
	if err != nil {
		t.Fatal(err)
	}
	receiptBefore, err := os.ReadFile(receipt.Path(active))
	if err != nil {
		t.Fatal(err)
	}
	commitFailure := errors.New("injected activation failure after registry registration")
	err = registry.Writer(Apply).RegisterForTransaction(root, "http://127.0.0.1:4200", func() error {
		registered, readErr := os.ReadFile(registry.Path)
		if readErr != nil {
			return readErr
		}
		if bytes.Equal(registered, registryBefore) || !bytes.Contains(registered, []byte("http://127.0.0.1:4200")) {
			return errors.New("Gateway registry was not updated before the commit callback")
		}
		return commitFailure
	})
	if !errors.Is(err, commitFailure) {
		t.Fatalf("transaction error = %v; want injected post-registration failure", err)
	}
	registryAfter, err := os.ReadFile(registry.Path)
	if err != nil || !bytes.Equal(registryAfter, registryBefore) {
		t.Fatalf("registry bytes = %q, %v; want exact prior bytes %q", registryAfter, err, registryBefore)
	}
	receiptAfter, err := os.ReadFile(receipt.Path(active))
	if err != nil || !bytes.Equal(receiptAfter, receiptBefore) {
		t.Fatalf("active receipt bytes = %q, %v; want exact prior bytes %q", receiptAfter, err, receiptBefore)
	}
}

func TestRegistryUnreadableIndexReturnsActionableCataloguedDiagnostic(t *testing.T) {
	base := t.TempDir()
	root, _, _ := installedRootSpellings(t, filepath.Join(base, "platform"))
	path := filepath.Join(base, "launcher", "gateway-roots.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct {
		name string
		data string
		want string
	}{
		{name: "schema 1", data: `{"schema":1,"roots":[]}`, want: "unsupported schema 1"},
		{name: "malformed", data: `{"schema":`, want: "unexpected end of JSON input"},
	} {
		t.Run(input.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(input.data), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := (Registry{Path: path, OperationRoot: root}).Read()
			var failure *diag.Diag
			if !errors.As(err, &failure) || failure.Code != contracts.CodeGatewayIndexUnavailable {
				t.Fatalf("Read error = %v, want catalogued Gateway index diagnostic", err)
			}
			if !strings.Contains(failure.Message, path) || !strings.Contains(failure.Message, input.want) ||
				failure.Meta["path"] != path || failure.Meta["reason"] == "" {
				t.Fatalf("diagnostic = %#v, want path and reason", failure)
			}
			remove := contracts.ShellCommand("rm", "--", path)
			repair := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root)
			if !strings.Contains(failure.Hint, remove) || !strings.Contains(failure.Hint, repair) {
				t.Fatalf("hint = %q, want ordered removal and receipt-based apply commands", failure.Hint)
			}
		})
	}
}

func installedRootSpellings(t *testing.T, root string) (string, string, string) {
	t.Helper()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(stage, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "gateway-test", InstallationID: installationID,
		Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "gateway-test"); err != nil {
		t.Fatal(err)
	}
	if err := layout.Validate(); err != nil {
		t.Fatal(err)
	}
	active, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	return layout.InstallRoot(), layout.PlatformRoot(), active
}

func TestAllocateUsesNextHundredPortOffsetAndKeepsRootAddress(t *testing.T) {
	root := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(root, "a"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(root, "b"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	if err := registry.Writer(Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || allocated != "http://127.0.0.1:4100" {
		t.Fatalf("allocated = %q, error = %v", allocated, err)
	}
	if err := registry.Writer(Apply).Register(rootB, allocated); err != nil {
		t.Fatal(err)
	}
	stable, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || stable != allocated {
		t.Fatalf("existing root allocation = %q, error = %v", stable, err)
	}
}

func TestAllocateRejectsNextOffsetWhoseServicePortEntersEphemeralRange(t *testing.T) {
	base := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(base, "a"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(base, "b"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	graph := contracts.ServiceGraph{Services: []contracts.Service{
		{ID: "gateway", Port: 4000},
		{ID: "mcp-daemon", Port: 30000},
	}}
	if err := registry.Writer(Apply).Register(rootA, "http://127.0.0.1:6700"); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(rootB, "http://127.0.0.1:6700", "", graph)
	if err == nil {
		t.Fatalf("allocated unsafe next Gateway %q; derived mcp-daemon port would be %d", allocated, 30000+(portFromOrigin(t, allocated)-4000))
	}
}

func TestAllocateMovesOutOfDomainDefaultIntoSafeProductDomain(t *testing.T) {
	root := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(root, "a"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	graph := contracts.ServiceGraph{Services: []contracts.Service{
		{ID: "gateway", Port: 4000},
		{ID: "mcp-daemon", Port: 5000},
	}}
	allocated, err := registry.Allocate(rootA, "http://127.0.0.1:36000", "", graph)
	if err != nil || allocated != "http://127.0.0.1:4000" {
		t.Fatalf("allocated = %q, error = %v; want first safe product-domain Gateway", allocated, err)
	}
}

func gatewayOnlyGraph() contracts.ServiceGraph {
	return contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Port: 4000}}}
}

func portFromOrigin(t *testing.T, origin string) int {
	t.Helper()
	port, err := strconv.Atoi(strings.TrimPrefix(origin, "http://127.0.0.1:"))
	if err != nil {
		t.Fatalf("parse port from %q: %v", origin, err)
	}
	return port
}

func TestAllocateHonorsExplicitAddress(t *testing.T) {
	root := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(root, "a"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(root, "b"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	if err := registry.Writer(Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "http://127.0.0.1:4200", gatewayOnlyGraph())
	if err != nil || allocated != "http://127.0.0.1:4200" {
		t.Fatalf("explicit Gateway = %q, error = %v", allocated, err)
	}
}

func TestRemoveReleasesAddressForNextRoot(t *testing.T) {
	root := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(root, "a"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(root, "b"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	if err := registry.Writer(Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	if err := registry.Writer(Apply).Remove(rootA); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || allocated != "http://127.0.0.1:4000" {
		t.Fatalf("allocated after remove = %q, error = %v", allocated, err)
	}
}

func TestStoppedRootKeepsItsGatewayAllocationUntilUninstall(t *testing.T) {
	base := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(base, "a"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(base, "b"))
	rootC, _, _ := installedRootSpellings(t, filepath.Join(base, "c"))
	registry := Registry{Path: filepath.Join(t.TempDir(), "launcher", "gateways.json")}
	if err := registry.Writer(Apply).RegisterMany([]Root{
		{PlatformRoot: rootA, URL: "http://127.0.0.1:4000"},
		{PlatformRoot: rootB, URL: "http://127.0.0.1:4100"},
	}); err != nil {
		t.Fatal(err)
	}

	stoppedRoot, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || stoppedRoot != "http://127.0.0.1:4100" {
		t.Fatalf("stopped root allocation = %q, error = %v; want its recorded address", stoppedRoot, err)
	}
	nextRoot, err := registry.Allocate(rootC, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || nextRoot != "http://127.0.0.1:4200" {
		t.Fatalf("next root allocation = %q, error = %v; want the next offset after the stopped root", nextRoot, err)
	}
}

func TestSameInstallationRejectsUnvalidatablePathsIncludingEqualSpellings(t *testing.T) {
	if SameInstallation("/missing/one", "/missing/one") {
		t.Fatal("equal unvalidatable paths compared as an installation identity")
	}
	if SameInstallation("/missing/one", "/missing/two") {
		t.Fatal("different unvalidatable paths compared as one installation")
	}
}

func TestAllocationReleasesAddressFromRemovedInstallation(t *testing.T) {
	registry := Registry{Path: filepath.Join(t.TempDir(), "gateway-roots.json")}
	base := t.TempDir()
	rootA, _, _ := installedRootSpellings(t, filepath.Join(base, "a"))
	removedRoot, _, _ := installedRootSpellings(t, filepath.Join(base, "removed"))
	rootB, _, _ := installedRootSpellings(t, filepath.Join(base, "b"))
	if err := registry.Writer(Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	if err := registry.Writer(Apply).Register(removedRoot, "http://127.0.0.1:4100"); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.ForPlatformPath(removedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(rootB, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || allocated != "http://127.0.0.1:4100" {
		t.Fatalf("allocation with a removed root's stale address row = %q, %v; want next free address 4100", allocated, err)
	}
	roots, err := registry.readFile()
	if err != nil || len(roots) != 2 {
		t.Fatalf("registry after allocation = %#v, %v; planning must leave the registry unchanged", roots, err)
	}
	claimant, claimed, err := registry.Claimant(rootB, "http://127.0.0.1:4100")
	if err != nil || claimed || claimant.URL != "" {
		t.Fatalf("removed root claimant = %#v, %v, %v; removed installations must not reserve an address", claimant, claimed, err)
	}
}

func TestUninstallRemovesGatewayRowByCapturedInstallationIdentity(t *testing.T) {
	base := t.TempDir()
	installRoot, _, _ := installedRootSpellings(t, filepath.Join(base, "platform"))
	layout, err := versionroot.ForPlatformPath(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	registry := Registry{Path: filepath.Join(base, "launcher", "gateways.json")}
	if err := registry.Writer(Apply).Register(installRoot, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	if err := layout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	if SameInstallation(installRoot, installRoot) || SameInstallation(installRoot, filepath.Join(base, "other")) {
		t.Fatal("removed installation still compared as a validated identity")
	}
	if err := registry.Writer(Apply).RemoveInstallation(installationID); err != nil {
		t.Fatal(err)
	}
	roots, err := registry.Read()
	if err != nil || len(roots) != 0 {
		t.Fatalf("registry after uninstall = %#v, %v; want own row removed by captured identity", roots, err)
	}
}

func TestRegistryUsesInstallationIdentityAcrossRootSpellings(t *testing.T) {
	root := t.TempDir()
	installRoot, currentRoot, versionRoot := installedRootSpellings(t, filepath.Join(root, "platform"))
	registry := Registry{Path: filepath.Join(root, "launcher", "gateways.json")}
	if err := registry.Writer(Apply).Register(currentRoot, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{installRoot, currentRoot, versionRoot} {
		allocated, err := registry.Allocate(spelling, "http://127.0.0.1:4000", "", gatewayOnlyGraph())
		if err != nil || allocated != "http://127.0.0.1:4000" {
			t.Fatalf("Allocate(%q) = %q, %v; want the existing installation address", spelling, allocated, err)
		}
		if _, claimed, err := registry.Claimant(spelling, allocated); err != nil || claimed {
			t.Fatalf("Claimant(%q) = claimed %t, error %v; installation cannot claim its own address", spelling, claimed, err)
		}
	}
	if err := registry.Writer(Apply).Register(versionRoot, "http://127.0.0.1:4100"); err != nil {
		t.Fatal(err)
	}
	roots, err := registry.Read()
	if err != nil || len(roots) != 1 || roots[0].URL != "http://127.0.0.1:4100" {
		t.Fatalf("registry after alias update = %#v, %v; want one updated installation", roots, err)
	}
	if err := registry.Writer(Apply).Remove(installRoot); err != nil {
		t.Fatal(err)
	}
	roots, err = registry.Read()
	if err != nil || len(roots) != 0 {
		t.Fatalf("registry after install-root removal = %#v, %v; want empty", roots, err)
	}
}

func TestAllocationIgnoresReceiptlessRootWithoutWritingRegistry(t *testing.T) {
	base := t.TempDir()
	root, _, active := installedRootSpellings(t, filepath.Join(base, "a"))
	registry := Registry{Path: filepath.Join(base, "gateway-roots.json")}
	if err := registry.Writer(Apply).Register(root, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(registry.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(receipt.Path(active)); err != nil {
		t.Fatal(err)
	}
	allocated, err := registry.Allocate(filepath.Join(base, "new"), "http://127.0.0.1:4000", "", gatewayOnlyGraph())
	if err != nil || allocated != "http://127.0.0.1:4000" {
		t.Fatalf("allocation=%q error=%v", allocated, err)
	}
	after, err := os.ReadFile(registry.Path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("planning changed registry: %v", err)
	}
}

func TestRegistryRejectsMissingMutationCapability(t *testing.T) {
	root, _, _ := installedRootSpellings(t, filepath.Join(t.TempDir(), "root"))
	path := filepath.Join(t.TempDir(), "gateway-roots.json")
	err := (Registry{Path: path}).Writer(0).Register(root, "http://127.0.0.1:4000")
	if err == nil {
		t.Fatal("write without a mutation was accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unauthorized writer changed registry: %v", err)
	}
}
