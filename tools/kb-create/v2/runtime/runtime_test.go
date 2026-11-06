package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	receiptpkg "github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

type fixedClock struct{ time.Time }

func (c fixedClock) Now() time.Time { return c.Time }

type fakeInstaller struct {
	artifacts  []contracts.Artifact
	restored   []contracts.Artifact
	err        error
	removed    []contracts.Artifact
	restores   int
	prepareErr error
	prepares   int
}

func (f *fakeInstaller) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	f.prepares++
	if f.prepareErr != nil {
		return nil, f.prepareErr
	}
	return fakePreparedArtifacts{install: func() error { return f.Install(items) }}, nil
}

type fakePreparedArtifacts struct{ install func() error }

func (f fakePreparedArtifacts) Install(func(string, bool) error) error { return f.install() }
func (fakePreparedArtifacts) Close() error                             { return nil }

func (f *fakeInstaller) Install(items []contracts.Artifact) error {
	f.artifacts = append(f.artifacts, items...)
	return f.err
}
func (f *fakeInstaller) Restore(plan, _ contracts.ResolvedInstallPlan) error {
	items := plan.Artifacts
	f.restored = append(f.restored, items...)
	f.restores++
	return nil
}
func (f *fakeInstaller) Uninstall(items []contracts.Artifact) error {
	f.removed = append(f.removed, items...)
	return nil
}

// fakeHostStart records the host lifecycle used by apply.
type fakeHostStart struct {
	specs   []contracts.HostSpec
	err     error
	stops   int
	onStart func()
}

func (p *fakeHostStart) Start(_ context.Context, spec contracts.HostSpec) (func() error, error) {
	p.specs = append(p.specs, spec)
	if p.onStart != nil {
		p.onStart()
	}
	if p.err != nil {
		return nil, p.err
	}
	return func() error { p.stops++; return nil }, nil
}

type fakeProbe struct {
	specs []contracts.HostSpec
	err   error
}

func (p *fakeProbe) Probe(_ context.Context, spec contracts.HostSpec) error {
	p.specs = append(p.specs, spec)
	return p.err
}

func testHost() *contracts.HostSpec {
	return &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}
}

func planIn(root, hash string) contracts.ResolvedInstallPlan {
	return contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: hash, Request: contracts.InstallRequest{PlatformRoot: root}, Host: testHost(), ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0"}}
}

func TestApplyCommitsReceiptOnlyAfterVerification(t *testing.T) {
	root := t.TempDir()
	plan := planIn(root, "123456789012345")
	plan.BinarySource = "http://127.0.0.1:8787"
	plan.Registry = "http://127.0.0.1:4873"
	plan.Artifacts = []contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "2.0.0"}}
	installer := &fakeInstaller{}
	receipt, err := Apply(context.Background(), plan, Dependencies{Artifacts: installer, Clock: fixedClock{time.Unix(0, 0)}, CorrelationID: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ID != "19700101T000000Z-123456789012" || len(installer.artifacts) != 1 {
		t.Fatalf("receipt/installer = %#v / %#v", receipt, installer)
	}
	persisted, err := receiptpkg.Read(root)
	if err != nil || persisted.Plan.BinarySource != plan.BinarySource || persisted.Plan.Registry != plan.Registry {
		t.Fatalf("persisted sources = %q / %q; error = %v", persisted.Plan.BinarySource, persisted.Plan.Registry, err)
	}
	if receipt.Verification.HostHealthURL != plan.Host.HealthURL || receipt.Verification.ConfigSHA256 == "" {
		t.Fatalf("verification = %#v", receipt.Verification)
	}
}

func TestUpdateKeepsUserConfigWhenTargetAddsServiceDefault(t *testing.T) {
	root := t.TempDir()
	if _, err := Apply(context.Background(), planIn(root, "old-plan"), Dependencies{Artifacts: &fakeInstaller{}}); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, ".kb", "kb.config.jsonc")
	userConfig := []byte("{\"platform\":{\"mode\":\"operator-choice\"}}\n")
	if err := os.WriteFile(configPath, userConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	target := planIn(root, "new-plan")
	target.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}, {ID: "new-service", Required: false}}
	target.Artifacts = []contracts.Artifact{{ID: "new-service", Package: "@kb-labs/new-service", Version: "2.1.0",
		Config: []contracts.ConfigRequirement{{ID: "new-service.mode", Default: "built-in"}}}}
	_, snapshot, err := Update(context.Background(), target, Dependencies{Artifacts: &fakeInstaller{}, PreserveGeneratedConfig: true, VerificationConfigRoot: root})
	if err != nil {
		t.Fatalf("target with a built-in optional service default did not verify against the stored config: %v", err)
	}
	if got := string(snapshot.Files[".kb/kb.config.jsonc"]); got != string(userConfig) {
		t.Fatalf("installer-owned rollback snapshot did not capture the active shared config: %q", got)
	}
	if got, err := os.ReadFile(configPath); err != nil || string(got) != string(userConfig) {
		t.Fatalf("update changed the user config: %q, %v", got, err)
	}
}

// case: S-222.12
func TestUpdateAndRollbackCannotRestoreDisclosedBootstrapPassword(t *testing.T) {
	for _, origin := range []struct {
		name   string
		origin secrets.BootstrapPasswordOrigin
	}{{name: "generated", origin: secrets.BootstrapOriginGenerated}, {name: "supplied", origin: secrets.BootstrapOriginSupplied}} {
		t.Run(origin.name, func(t *testing.T) {
			root := t.TempDir()
			if _, err := Apply(context.Background(), planIn(root, "bootstrap-before-update"), Dependencies{Artifacts: &fakeInstaller{}}); err != nil {
				t.Fatal(err)
			}
			store := secrets.Store{PlatformRoot: root}
			const password = "update-rollback-disclosure-sentinel"
			if err := store.PutBootstrapPassword(password, origin.origin); err != nil {
				t.Fatal(err)
			}
			if err := store.Put(secrets.BootstrapPasswordEnvironment, password); err != nil {
				t.Fatal(err)
			}
			if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
				t.Fatal(err)
			}
			if err := store.MarkBootstrapDisclosed(); err != nil {
				t.Fatal(err)
			}
			layout, err := versionroot.New(root)
			if err != nil {
				t.Fatal(err)
			}
			foundSharedLifecycle := false
			if err := filepath.WalkDir(layout.SharedStateDir(), func(path string, entry os.DirEntry, walkErr error) error {
				if walkErr != nil || entry.IsDir() {
					return walkErr
				}
				data, err := os.ReadFile(path)
				if err == nil && strings.Contains(string(data), "provisioned") {
					foundSharedLifecycle = true
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if !foundSharedLifecycle {
				t.Fatal("bootstrap lifecycle state was not stored in the install-owned shared state directory")
			}
			updated, snapshot, err := Update(context.Background(), planIn(root, "bootstrap-after-update"), Dependencies{Artifacts: &fakeInstaller{}, Secrets: &store})
			if err != nil {
				t.Fatalf("update: %v", err)
			}
			if updated.SnapshotID != snapshot.ID {
				t.Fatalf("update snapshot ID = %q, returned snapshot %q", updated.SnapshotID, snapshot.ID)
			}
			if _, err := Rollback(root, snapshot.ID, Dependencies{Artifacts: &fakeInstaller{}, Secrets: &store}); err != nil {
				t.Fatalf("rollback: %v", err)
			}
			assertRuntimeSecretAbsentFromTree(t, root, password)
			for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
				if present, err := store.Exists(name); err != nil || present {
					t.Fatalf("update/rollback restored bootstrap secret %q: present=%v err=%v", name, present, err)
				}
			}
		})
	}
}

func assertRuntimeSecretAbsentFromTree(t *testing.T, root, secret string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), secret) {
			t.Errorf("disclosed bootstrap password remains in %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// case: S-023.2
func TestApplyRejectsDuplicateArtifactIdentitiesBeforeInstalling(t *testing.T) {
	plan := planIn(t.TempDir(), "duplicate-plan")
	plan.Artifacts = []contracts.Artifact{
		{ID: "sqlite", Kind: "platform-member", Package: "@kb/adapters-sqlite"},
		{ID: "sqlite", Kind: "adapter", Package: "@kb/adapters-sqlite"},
	}
	installer := &fakeInstaller{}
	_, err := Apply(context.Background(), plan, Dependencies{Artifacts: installer})
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeArtifactIdentityInvalid {
		t.Fatalf("apply error = %#v, want catalogued artifact identity diagnostic", err)
	}
	if len(installer.artifacts) != 0 {
		t.Fatalf("installer received invalid plan artifacts: %#v", installer.artifacts)
	}
}

// case: PC-001.4, S-039.2
func TestApplyStartsAndRetainsTheResolvedHost(t *testing.T) {
	root := t.TempDir()
	host := &fakeHostStart{}
	if _, err := Apply(context.Background(), planIn(root, "plan"), Dependencies{Artifacts: &fakeInstaller{}, Host: host}); err != nil {
		t.Fatal(err)
	}
	if len(host.specs) != 1 || host.specs[0].Command != "kb-host" || host.stops != 0 {
		t.Fatalf("host starts/stops = %#v / %d", host.specs, host.stops)
	}
}

// case: PC-001.6
func TestApplyStopsHostAndPreservesPreviousStateWhenVerificationFails(t *testing.T) {
	root := t.TempDir()
	previous := contracts.InstallReceipt{ID: "previous", InstallationID: "stable"}
	if err := receiptpkg.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, ".kb", "kb.config.jsonc")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("previous config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	marketplacePath := filepath.Join(root, ".kb", "marketplace.lock")
	previousMarketplace := `{"schema":"kb.marketplace/3","plugins":{"previous":{"version":"1","integrity":"sha256-old","resolvedPath":"node_modules/previous","package":"@test/previous","source":"platform","enabled":true}}}` + "\n"
	if err := os.WriteFile(marketplacePath, []byte(previousMarketplace), 0o600); err != nil {
		t.Fatal(err)
	}
	packagePath := filepath.Join(root, "node_modules", "@test", "next")
	if err := os.MkdirAll(packagePath, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packagePath, "package.json"), []byte(`{"name":"@test/next","version":"2"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := planIn(root, "new-plan")
	plan.Artifacts = []contracts.Artifact{{ID: "next", Kind: "plugin", Package: "@test/next", Version: "2"}}
	host := &fakeHostStart{onStart: func() { _ = os.Remove(configPath) }}
	_, err := Apply(context.Background(), plan, Dependencies{Artifacts: &fakeInstaller{}, Host: host})
	if err == nil {
		t.Fatal("verification must fail when the running host removes the generated config")
	}
	if host.stops != 1 {
		t.Fatalf("failed verification left the host running: stops = %d", host.stops)
	}
	got, readErr := receiptpkg.Read(root)
	if readErr != nil || got.ID != previous.ID || got.InstallationID != previous.InstallationID {
		t.Fatalf("previous receipt = %#v, %v", got, readErr)
	}
	config, readErr := os.ReadFile(configPath)
	if readErr != nil || string(config) != "previous config\n" {
		t.Fatalf("previous config = %q, %v", config, readErr)
	}
	marketplace, readErr := os.ReadFile(marketplacePath)
	if readErr != nil || string(marketplace) != previousMarketplace {
		t.Fatalf("previous marketplace lock = %q, %v", marketplace, readErr)
	}
}

func TestApplyRemovesGeneratedProjectionWhenTheHostDoesNotStart(t *testing.T) {
	root := t.TempDir()
	_, err := Apply(context.Background(), planIn(root, "plan"), Dependencies{Artifacts: &fakeInstaller{}, Host: &fakeHostStart{err: errors.New("port in use")}})
	if err == nil || !strings.Contains(err.Error(), "port in use") {
		t.Fatalf("expected the host failure, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".kb", "kb.config.jsonc")); !os.IsNotExist(statErr) {
		t.Fatalf("stale config after failed apply: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".kb", "v2", "receipt.json")); !os.IsNotExist(statErr) {
		t.Fatalf("receipt after failed apply: %v", statErr)
	}
}

// case: S-005.1
func TestApplyClientProfileInstallsWithoutRuntimeConfigOrHostProbe(t *testing.T) {
	root := t.TempDir()
	probe := &fakeHostStart{}
	plan := contracts.ResolvedInstallPlan{
		Schema:       contracts.ResolvedPlanSchema,
		Request:      contracts.InstallRequest{PlatformRoot: root},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Profile: "client"},
	}
	if _, err := Apply(context.Background(), plan, Dependencies{Artifacts: &fakeInstaller{}, Host: probe}); err != nil {
		t.Fatal(err)
	}
	if len(probe.specs) != 0 {
		t.Fatalf("client host starts = %#v", probe.specs)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "kb.config.jsonc")); !os.IsNotExist(err) {
		t.Fatalf("client runtime config stat error = %v", err)
	}
	if _, err := receiptpkg.Read(root); err != nil {
		t.Fatalf("client receipt was not committed: %v", err)
	}
}

func TestApplyRejectsAPlanWithoutAHost(t *testing.T) {
	root := t.TempDir()
	plan := planIn(root, "plan")
	plan.Host = nil
	if _, err := Apply(context.Background(), plan, Dependencies{Artifacts: &fakeInstaller{}}); err == nil {
		t.Fatal("a plan without a host must not become an installation")
	}
	if _, statErr := os.Stat(filepath.Join(root, ".kb", "v2", "receipt.json")); !os.IsNotExist(statErr) {
		t.Fatalf("receipt after failed apply: %v", statErr)
	}
}

func TestApplyDoesNotCommitReceiptWhenArtifactInstallFails(t *testing.T) {
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: testHost(), Request: contracts.InstallRequest{PlatformRoot: t.TempDir()}}
	_, err := Apply(context.Background(), plan, Dependencies{Artifacts: &fakeInstaller{err: errors.New("registry unavailable")}})
	if err == nil {
		t.Fatal("expected apply failure")
	}
}

func TestUpdateSnapshotsPreviousVerifiedReceipt(t *testing.T) {
	root := t.TempDir()
	previous := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", InstallationID: "stable-installation",
		ProjectSelectedPath: "/work/selected-alias", ProjectID: "prj_0123456789abcdef", ProjectCanonicalPath: "/work/project",
		Plan: contracts.ResolvedInstallPlan{PlanHash: "old"}}
	if err := receiptpkg.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	result, snapshot, err := Update(context.Background(), planIn(root, "new-plan-123456"), Dependencies{Artifacts: &fakeInstaller{}, Clock: fixedClock{time.Unix(4, 0)}})
	if err != nil || snapshot.ReceiptID != "before" || result.SnapshotID != snapshot.ID {
		t.Fatalf("result/snapshot/err = %#v / %#v / %v", result, snapshot, err)
	}
	if result.InstallationID != "stable-installation" {
		t.Fatalf("update installation ID = %q", result.InstallationID)
	}
	if result.ProjectSelectedPath != previous.ProjectSelectedPath || result.ProjectID != previous.ProjectID || result.ProjectCanonicalPath != previous.ProjectCanonicalPath {
		t.Fatalf("update did not preserve registry project identity: %#v", result)
	}
}

func TestUninstallRemovesPlatformRootAfterRemovingReceiptArtifacts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
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
	installed := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", InstallationID: installationID,
		Plan: contracts.ResolvedInstallPlan{PlanHash: "old", Request: contracts.InstallRequest{PlatformRoot: root},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}, Artifacts: []contracts.Artifact{{ID: "plugin", Package: "@kb/plugin"}}}}
	if err := receiptpkg.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stage, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, ".kb", "kb.config.jsonc"), []byte("managed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "user.txt"), []byte("user"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "old"); err != nil {
		t.Fatal(err)
	}
	stage, err = layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	installed.ID, installed.Plan.PlanHash = "after", "new"
	installed.Plan.ServiceGraph.PlatformVersion = "2.0.0"
	if err := receiptpkg.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.Activate(stage, "2.0.0", "new", ""); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(layout.VersionsDir()); err != nil || len(entries) != 2 {
		t.Fatalf("uninstall fixture must include two version roots: %d, %v", len(entries), err)
	}
	installer := &fakeInstaller{}
	if _, err := Uninstall(root, Dependencies{Artifacts: installer, Clock: fixedClock{time.Unix(5, 0)}}); err != nil {
		t.Fatal(err)
	}
	if len(installer.removed) != 1 || installer.removed[0].ID != "plugin" {
		t.Fatalf("removed = %#v", installer.removed)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("successful uninstall must remove the platform root and its snapshots, err = %v", err)
	}
}

func TestUpdateRestoresPreviousReceiptWhenTheNewHostDoesNotStart(t *testing.T) {
	root := t.TempDir()
	previousArtifacts := []contracts.Artifact{{ID: "previous", Package: "@kb/previous", Version: "1.0.0"}}
	if err := receiptpkg.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", InstallationID: "stable-installation", Plan: contracts.ResolvedInstallPlan{PlanHash: "old", Artifacts: previousArtifacts}}); err != nil {
		t.Fatal(err)
	}
	installer := &fakeInstaller{}
	_, snapshot, err := Update(context.Background(), planIn(root, "new-plan"), Dependencies{Artifacts: installer, Probe: &fakeProbe{err: errors.New("crash on boot")}, Clock: fixedClock{time.Unix(6, 0)}})
	if err == nil || snapshot.ID == "" || installer.restores != 1 {
		t.Fatalf("err/snapshot/restores = %v / %#v / %d", err, snapshot, installer.restores)
	}
	if !reflect.DeepEqual(installer.restored, previousArtifacts) {
		t.Fatalf("restored artifacts = %#v, want previous receipt plan %#v", installer.restored, previousArtifacts)
	}
	active, readErr := receiptpkg.Read(root)
	if readErr != nil || active.ID != "before" || active.InstallationID != "stable-installation" {
		t.Fatalf("receipt = %#v, %v", active, readErr)
	}
}

// case: PC-001.13
func TestFreshApplyGeneratesStableInstallationIdentityForHostAndReceipt(t *testing.T) {
	root := t.TempDir()
	store := &secrets.Store{PlatformRoot: root}
	probe := &fakeHostStart{}
	result, err := Apply(context.Background(), planIn(root, "first-plan"), Dependencies{Artifacts: &fakeInstaller{}, Host: probe, Secrets: store})
	if err != nil {
		t.Fatal(err)
	}
	if result.InstallationID == "" || probe.specs[0].Env["KB_INSTALLATION_ID"] != result.InstallationID {
		t.Fatalf("receipt identity %q, probed host identity %q", result.InstallationID, probe.specs[0].Env["KB_INSTALLATION_ID"])
	}
	if result.Plan.Host == nil || result.Plan.Host.Env["KB_INSTALLATION_ID"] != "" {
		t.Fatalf("launcher-owned process identity leaked into the persisted host declaration: %#v", result.Plan.Host)
	}
	if stored, present, err := store.Get("installation.id"); err != nil || !present || stored != result.InstallationID {
		t.Fatalf("persistent installation ID = %q, present=%v, error=%v", stored, present, err)
	}
	updated, _, err := Update(context.Background(), planIn(root, "updated-plan"), Dependencies{Artifacts: &fakeInstaller{}, Secrets: store})
	if err != nil {
		t.Fatal(err)
	}
	if updated.InstallationID != result.InstallationID {
		t.Fatalf("installation ID changed on update: before=%q after=%q", result.InstallationID, updated.InstallationID)
	}
}

// case: PC-001.13
func TestGatewayAddressPersistsAcrossUpdateAndRollback(t *testing.T) {
	root := t.TempDir()
	store := &secrets.Store{PlatformRoot: root}
	plan := planIn(root, "gateway-before")
	plan.Request.GatewayURL = "http://127.0.0.1:4100"
	plan.Host.HealthURL = plan.Request.GatewayURL + "/health"
	installed, err := Apply(context.Background(), plan, Dependencies{Artifacts: &fakeInstaller{}, Host: &fakeHostStart{}, Secrets: store})
	if err != nil {
		t.Fatal(err)
	}
	next := planIn(root, "gateway-after")
	next.Request.GatewayURL = "http://127.0.0.1:4100"
	next.Host.HealthURL = next.Request.GatewayURL + "/health"
	updated, snapshot, err := Update(context.Background(), next, Dependencies{Artifacts: &fakeInstaller{}, Secrets: store})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Plan.Request.GatewayURL != installed.Plan.Request.GatewayURL ||
		updated.Verification.HostHealthURL != installed.Verification.HostHealthURL {
		t.Fatalf("Gateway changed on update: initial=%#v updated=%#v", installed.Plan.Request, updated.Plan.Request)
	}
	if _, err := Rollback(root, snapshot.ID, Dependencies{Artifacts: &fakeInstaller{}}); err != nil {
		t.Fatal(err)
	}
	restored, err := receiptpkg.Read(root)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Plan.Request.GatewayURL != installed.Plan.Request.GatewayURL ||
		restored.Verification.HostHealthURL != installed.Verification.HostHealthURL {
		t.Fatalf("Gateway changed on rollback: initial=%#v restored=%#v", installed.Plan.Request, restored.Plan.Request)
	}
}

// case: PC-001.14
func TestUpdateRejectsReceiptWithoutInstallationIdentity(t *testing.T) {
	root := t.TempDir()
	if err := receiptpkg.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "receipt-old"}); err != nil {
		t.Fatal(err)
	}
	_, _, err := Update(context.Background(), planIn(root, "new-plan"), Dependencies{Artifacts: &fakeInstaller{}})
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeReceiptUnavailable || !strings.Contains(failure.Hint, contracts.ShellCommand("kb-create", "update", "--platform-root", root)) {
		t.Fatalf("missing installation ID error = %v", err)
	}
}

func TestUpdateRejectsMissingDependenciesBeforeSnapshot(t *testing.T) {
	plan := contracts.ResolvedInstallPlan{
		Schema:  contracts.ResolvedPlanSchema,
		Request: contracts.InstallRequest{PlatformRoot: t.TempDir()},
	}
	_, snapshot, err := Update(context.Background(), plan, Dependencies{})
	if err == nil || snapshot.ID != "" {
		t.Fatalf("result = snapshot %#v, error %v", snapshot, err)
	}
}

func TestUpdateRequiresArtifactPreparationBeforeSnapshot(t *testing.T) {
	root := t.TempDir()
	preparationFailure := errors.New("sealed digest mismatch")
	installer := &fakeInstaller{prepareErr: preparationFailure}
	_, snapshot, err := Update(context.Background(), planIn(root, "verified-update-plan"), Dependencies{Artifacts: installer})
	if !errors.Is(err, preparationFailure) || snapshot.ID != "" || installer.prepares != 1 || len(installer.artifacts) != 0 {
		t.Fatalf("update = snapshot %#v, installer %#v, error %v; want verification refusal before snapshot/install", snapshot, installer, err)
	}
	layout, layoutErr := versionroot.New(root)
	if layoutErr != nil {
		t.Fatal(layoutErr)
	}
	if _, statErr := os.Stat(layout.SnapshotsDir()); !os.IsNotExist(statErr) {
		t.Fatalf("verification refusal created snapshot storage: %v", statErr)
	}
}

func TestUpdateInstallsTheSingleVerifiedArtifactResponse(t *testing.T) {
	root := t.TempDir()
	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("2.0.0", "2.0.0", "darwin", "arm64"), &source); err != nil {
		t.Fatal(err)
	}
	source = testfixtures.MustSealCatalog(source)
	verified, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := receiptpkg.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before",
		InstallationID: "stable-installation", Plan: contracts.ResolvedInstallPlan{PlanHash: "old", ReleaseCatalog: encoded}}); err != nil {
		t.Fatal(err)
	}
	good := []byte("sealed binary bytes")
	corrupt := []byte("second response is corrupt")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			_, _ = writer.Write(good)
			return
		}
		_, _ = writer.Write(corrupt)
	}))
	t.Cleanup(server.Close)
	item := contracts.Artifact{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL,
		SHA256: fmt.Sprintf("%x", sha256.Sum256(good)), Target: "kb-dev"}
	plan := planIn(root, "new-plan-123456")
	plan.Artifacts = []contracts.Artifact{item}
	cacheRoot := filepath.Join(root, ".kb", "v2", "cache")
	installer := artifacts.Composite{
		Packages: artifacts.Pnpm{Root: root, CacheRoot: cacheRoot, ReleaseCatalog: verified},
		Binaries: artifacts.Binaries{Root: root, CacheRoot: cacheRoot},
	}
	_, snapshot, err := Update(context.Background(), plan, Dependencies{Artifacts: installer, Probe: &fakeProbe{}, Clock: fixedClock{time.Unix(4, 0)}})
	if err != nil || snapshot.ID == "" {
		t.Fatalf("update = snapshot %#v, error %v", snapshot, err)
	}
	installed, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "bin", "kb-dev"))
	if err != nil || !reflect.DeepEqual(installed, good) {
		t.Fatalf("installed bytes = %q, error %v; want the first verified response %q", installed, err, good)
	}
	if requests != 1 {
		t.Fatalf("artifact source received %d requests; want exactly one", requests)
	}
}

// case: PC-001.14
func TestRollbackRestoresSnapshotAndVerifiesTheRestoredInstallation(t *testing.T) {
	root := t.TempDir()
	installed, err := Apply(context.Background(), planIn(root, "before"), Dependencies{Artifacts: &fakeInstaller{}, Clock: fixedClock{time.Unix(8, 0)}})
	if err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := receiptpkg.CreateSnapshot(root, layout.SnapshotsDir(), time.Unix(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	installer := &fakeInstaller{}
	if _, err := Rollback(root, snapshot.ID, Dependencies{Artifacts: installer}); err != nil {
		t.Fatal(err)
	}
	if installer.restores != 1 {
		t.Fatalf("restores = %d", installer.restores)
	}
	active, err := receiptpkg.Read(root)
	if err != nil || active.InstallationID != installed.InstallationID {
		t.Fatalf("restored identity = %q, error=%v; want %q", active.InstallationID, err, installed.InstallationID)
	}
	if _, err := Rollback(root, "", Dependencies{Artifacts: installer}); err == nil {
		t.Fatal("rollback must name its snapshot")
	}
}

func TestRollbackVerifiesConfigAtRestoredRootWhenReceiptKeepsItsOriginalRequestPath(t *testing.T) {
	root := t.TempDir()
	installed, err := Apply(context.Background(), planIn(root, "before"), Dependencies{Artifacts: &fakeInstaller{}, Clock: fixedClock{time.Unix(18, 0)}})
	if err != nil {
		t.Fatal(err)
	}
	installed.Plan.Request.PlatformRoot = filepath.Join(t.TempDir(), "removed-version-root")
	if err := receiptpkg.Write(root, installed); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := receiptpkg.CreateSnapshot(root, layout.SnapshotsDir(), time.Unix(19, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Rollback(root, snapshot.ID, Dependencies{Artifacts: &fakeInstaller{}}); err != nil {
		t.Fatalf("rollback must verify the restored config under %s, not the stale plan path: %v", root, err)
	}
}

func TestDoctorFixRejectsRequiredInputBeforeMutating(t *testing.T) {
	_, err := DoctorFix(t.TempDir(), doctor.RepairPlan{RequiredInput: []doctor.Finding{{Path: "/token"}}}, Dependencies{})
	if err == nil {
		t.Fatal("expected required-input rejection")
	}
}

func TestDoctorFixSnapshotsSafeDefaultAndVerifies(t *testing.T) {
	root := t.TempDir()
	if _, err := Apply(context.Background(), planIn(root, "doctor"), Dependencies{Artifacts: &fakeInstaller{}}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := DoctorFix(root, doctor.RepairPlan{SafeDefaults: []doctor.Finding{{Path: "/platform/mode", Default: []byte(`"safe"`)}}}, Dependencies{Clock: fixedClock{time.Unix(12, 0)}})
	if err != nil || snapshot.ID == "" {
		t.Fatalf("snapshot/error = %#v / %v", snapshot, err)
	}
	data, readErr := os.ReadFile(filepath.Join(root, ".kb", "kb.config.jsonc"))
	if readErr != nil || !strings.Contains(string(data), `"mode": "safe"`) {
		t.Fatalf("config/error = %s / %v", data, readErr)
	}
}
