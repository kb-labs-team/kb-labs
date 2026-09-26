package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/receipt"
)

type fixedClock struct{ time.Time }

func (c fixedClock) Now() time.Time { return c.Time }

type fakeInstaller struct {
	artifacts []contracts.Artifact
	err       error
	removed   []contracts.Artifact
	restores  int
}

func (f *fakeInstaller) Install(items []contracts.Artifact) error {
	f.artifacts = append(f.artifacts, items...)
	return f.err
}
func (f *fakeInstaller) Restore() error { f.restores++; return nil }
func (f *fakeInstaller) Uninstall(items []contracts.Artifact) error {
	f.removed = append(f.removed, items...)
	return nil
}

// fakeProbe records the specs it was asked to run.
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
	plan.Artifacts = []contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "2.0.0"}}
	installer := &fakeInstaller{}
	receipt, err := Apply(context.Background(), plan, Dependencies{Artifacts: installer, Clock: fixedClock{time.Unix(0, 0)}, CorrelationID: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ID != "19700101T000000Z-123456789012" || len(installer.artifacts) != 1 {
		t.Fatalf("receipt/installer = %#v / %#v", receipt, installer)
	}
	if receipt.Verification.HostHealthURL != plan.Host.HealthURL || receipt.Verification.ConfigSHA256 == "" {
		t.Fatalf("verification = %#v", receipt.Verification)
	}
}

func TestApplyProbesTheResolvedHostBeforeCommitting(t *testing.T) {
	root := t.TempDir()
	probe := &fakeProbe{}
	if _, err := Apply(context.Background(), planIn(root, "plan"), Dependencies{Artifacts: &fakeInstaller{}, Host: probe}); err != nil {
		t.Fatal(err)
	}
	if len(probe.specs) != 1 || probe.specs[0].Command != "kb-host" {
		t.Fatalf("probed = %#v", probe.specs)
	}
}

func TestApplyRemovesGeneratedProjectionWhenTheHostDoesNotStart(t *testing.T) {
	root := t.TempDir()
	_, err := Apply(context.Background(), planIn(root, "plan"), Dependencies{Artifacts: &fakeInstaller{}, Host: &fakeProbe{err: errors.New("port in use")}})
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
	previous := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: contracts.ResolvedInstallPlan{PlanHash: "old"}}
	if err := receipt.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	result, snapshot, err := Update(context.Background(), planIn(root, "new-plan-123456"), Dependencies{Artifacts: &fakeInstaller{}, Clock: fixedClock{time.Unix(4, 0)}})
	if err != nil || snapshot.ReceiptID != "before" || result.SnapshotID != snapshot.ID {
		t.Fatalf("result/snapshot/err = %#v / %#v / %v", result, snapshot, err)
	}
}

func TestUninstallUsesReceiptArtifacts(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: contracts.ResolvedInstallPlan{PlanHash: "old", Artifacts: []contracts.Artifact{{ID: "plugin", Package: "@kb/plugin"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "kb.config.jsonc"), []byte("managed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "user.txt"), []byte("user"), 0o600); err != nil {
		t.Fatal(err)
	}
	installer := &fakeInstaller{}
	if _, err := Uninstall(root, Dependencies{Artifacts: installer, Clock: fixedClock{time.Unix(5, 0)}}); err != nil {
		t.Fatal(err)
	}
	if len(installer.removed) != 1 || installer.removed[0].ID != "plugin" {
		t.Fatalf("removed = %#v", installer.removed)
	}
	if _, err := receipt.Read(root); !os.IsNotExist(err) {
		t.Fatalf("receipt must be removed, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "kb.config.jsonc")); !os.IsNotExist(err) {
		t.Fatalf("managed config must be removed, err = %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "user.txt")); string(data) != "user" {
		t.Fatalf("user file = %q", data)
	}
}

func TestUpdateRestoresPreviousReceiptWhenTheNewHostDoesNotStart(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: contracts.ResolvedInstallPlan{PlanHash: "old"}}); err != nil {
		t.Fatal(err)
	}
	installer := &fakeInstaller{}
	_, snapshot, err := Update(context.Background(), planIn(root, "new-plan"), Dependencies{Artifacts: installer, Host: &fakeProbe{err: errors.New("crash on boot")}, Clock: fixedClock{time.Unix(6, 0)}})
	if err == nil || snapshot.ID == "" || installer.restores != 1 {
		t.Fatalf("err/snapshot/restores = %v / %#v / %d", err, snapshot, installer.restores)
	}
	active, readErr := receipt.Read(root)
	if readErr != nil || active.ID != "before" {
		t.Fatalf("receipt = %#v, %v", active, readErr)
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

func TestRollbackRestoresSnapshotAndVerifiesTheRestoredInstallation(t *testing.T) {
	root := t.TempDir()
	if _, err := Apply(context.Background(), planIn(root, "before"), Dependencies{Artifacts: &fakeInstaller{}, Clock: fixedClock{time.Unix(8, 0)}}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := receipt.CreateSnapshot(root, time.Unix(9, 0))
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
	if _, err := Rollback(root, "", Dependencies{Artifacts: installer}); err == nil {
		t.Fatal("rollback must name its snapshot")
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
