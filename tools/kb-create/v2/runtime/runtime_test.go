package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/verify"
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

type fakeStatus []verify.ObservedService

func (s fakeStatus) ServiceStatuses(string) ([]verify.ObservedService, error) { return s, nil }

type fakeActivator struct {
	ids []string
	err error
}

func (a *fakeActivator) Ensure(_ string, ids []string) error {
	a.ids = append(a.ids, ids...)
	return a.err
}
func (a *fakeActivator) Stop(_ string, ids []string) error {
	a.ids = append(a.ids, ids...)
	return a.err
}

func TestApplyCommitsReceiptOnlyAfterGraphVerification(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "123456789012345", Request: contracts.InstallRequest{PlatformRoot: root}, Artifacts: []contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "2.0.0"}}, ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	installer := &fakeInstaller{}
	receipt, err := Apply(plan, Dependencies{Artifacts: installer, Status: fakeStatus{{ID: "gateway", State: "alive"}}, Clock: fixedClock{time.Unix(0, 0)}, CorrelationID: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ID != "19700101T000000Z-123456789012" || len(installer.artifacts) != 1 {
		t.Fatalf("receipt/installer = %#v / %#v", receipt, installer)
	}
}

func TestApplyEnsuresResolvedGraphBeforeVerification(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	activator := &fakeActivator{}
	if _, err := Apply(plan, Dependencies{Artifacts: &fakeInstaller{}, Activator: activator, Status: fakeStatus{{ID: "gateway", State: "alive"}}}); err != nil {
		t.Fatal(err)
	}
	if len(activator.ids) != 1 || activator.ids[0] != "gateway" {
		t.Fatalf("ensured = %#v", activator.ids)
	}
}

func TestApplyDoesNotCommitReceiptWhenArtifactInstallFails(t *testing.T) {
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Request: contracts.InstallRequest{PlatformRoot: t.TempDir()}}
	_, err := Apply(plan, Dependencies{Artifacts: &fakeInstaller{err: errors.New("registry unavailable")}, Status: fakeStatus{}})
	if err == nil {
		t.Fatal("expected apply failure")
	}
}

func TestApplyRemovesGeneratedProjectionWhenReadinessFails(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "plan", Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	_, err := Apply(plan, Dependencies{Artifacts: &fakeInstaller{}, Status: fakeStatus{}})
	if err == nil {
		t.Fatal("expected readiness failure")
	}
	if _, statErr := os.Stat(filepath.Join(root, ".kb", "kb.config.jsonc")); !os.IsNotExist(statErr) {
		t.Fatalf("stale config after failed apply: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".kb", "v2", "receipt.json")); !os.IsNotExist(statErr) {
		t.Fatalf("receipt after failed apply: %v", statErr)
	}
}

func TestUpdateSnapshotsPreviousVerifiedReceipt(t *testing.T) {
	root := t.TempDir()
	previous := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: contracts.ResolvedInstallPlan{PlanHash: "old"}}
	if err := receipt.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "new-plan-123456", Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	result, snapshot, err := Update(plan, Dependencies{Artifacts: &fakeInstaller{}, Status: fakeStatus{{ID: "gateway", State: "alive"}}, Clock: fixedClock{time.Unix(4, 0)}})
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
	services := &fakeActivator{}
	if _, err := Uninstall(root, Dependencies{Artifacts: installer, Status: fakeStatus{}, Activator: services, Deactivator: services, Clock: fixedClock{time.Unix(5, 0)}}); err != nil {
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

func TestUninstallChecksServicesAreStoppedBeforeRemovingKBDev(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{
		PlanHash:     "old",
		Artifacts:    []contracts.Artifact{{ID: "kb-dev", Kind: "binary", Target: "kb-dev"}},
		ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway"}}},
	}
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: plan}); err != nil {
		t.Fatal(err)
	}
	installer := &fakeInstaller{}
	services := &fakeActivator{}
	_, err := Uninstall(root, Dependencies{
		Artifacts: installer, Status: fakeStatus{{ID: "gateway", State: "alive"}},
		Activator: services, Deactivator: services, Clock: fixedClock{time.Unix(6, 0)},
	})
	if err == nil || !strings.Contains(err.Error(), "uninstall left service gateway in state alive") {
		t.Fatalf("error = %v", err)
	}
	if len(installer.removed) != 0 {
		t.Fatalf("artifacts were removed before stopped-state verification: %#v", installer.removed)
	}
}

func TestUpdateRestoresPreviousReceiptWhenNewGraphFailsVerification(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", Plan: contracts.ResolvedInstallPlan{PlanHash: "old"}}); err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "new-plan", Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	installer := &fakeInstaller{}
	_, snapshot, err := Update(plan, Dependencies{Artifacts: installer, Status: fakeStatus{}, Clock: fixedClock{time.Unix(6, 0)}})
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
	_, snapshot, err := Update(plan, Dependencies{})
	if err == nil || snapshot.ID != "" {
		t.Fatalf("result = snapshot %#v, error %v", snapshot, err)
	}
}

func TestRollbackRestoresSnapshotAndEnsuresGraph(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "before", Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	if _, err := Apply(plan, Dependencies{Artifacts: &fakeInstaller{}, Status: fakeStatus{{ID: "gateway", State: "alive"}}, Clock: fixedClock{time.Unix(8, 0)}}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := receipt.CreateSnapshot(root, time.Unix(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	activator := &fakeActivator{}
	if _, err := Rollback(root, snapshot.ID, Dependencies{Artifacts: &fakeInstaller{}, Activator: activator, Status: fakeStatus{{ID: "gateway", State: "alive"}}}); err != nil {
		t.Fatal(err)
	}
	if len(activator.ids) != 1 || activator.ids[0] != "gateway" {
		t.Fatalf("ensured = %#v", activator.ids)
	}
}

func TestDoctorFixRejectsRequiredInputBeforeMutating(t *testing.T) {
	_, err := DoctorFix(t.TempDir(), doctor.RepairPlan{RequiredInput: []doctor.Finding{{Path: "/token"}}}, Dependencies{})
	if err == nil {
		t.Fatal("expected required-input rejection")
	}
}

func TestDoctorFixSnapshotsSafeDefaultAndVerifiesGraph(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "doctor", Request: contracts.InstallRequest{PlatformRoot: root}, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Required: true}}}}
	if _, err := Apply(plan, Dependencies{Artifacts: &fakeInstaller{}, Status: fakeStatus{{ID: "gateway", State: "alive"}}}); err != nil {
		t.Fatal(err)
	}
	activator := &fakeActivator{}
	snapshot, err := DoctorFix(root, doctor.RepairPlan{SafeDefaults: []doctor.Finding{{Path: "/platform/mode", Default: []byte(`"safe"`)}}}, Dependencies{Activator: activator, Status: fakeStatus{{ID: "gateway", State: "alive"}}, Clock: fixedClock{time.Unix(12, 0)}})
	if err != nil || snapshot.ID == "" || len(activator.ids) != 1 {
		t.Fatalf("snapshot/error/ensured = %#v / %v / %#v", snapshot, err, activator.ids)
	}
	data, readErr := os.ReadFile(filepath.Join(root, ".kb", "kb.config.jsonc"))
	if readErr != nil || !strings.Contains(string(data), `"mode": "safe"`) {
		t.Fatalf("config/error = %s / %v", data, readErr)
	}
}
